var mkdir = require("mkdirp")
  , assert = require("assert")
  , git = require("../utils/git.js")
  , fs = require("graceful-fs")
  , log = require("npmlog")
  , path = require("path")
  , url = require("url")
  , chownr = require("chownr")
  , crypto = require("crypto")
  , npm = require("../npm.js")
  , rm = require("../utils/gently-rm.js")
  , inflight = require("inflight")
  , getCacheStat = require("./get-stat.js")
  , addLocal = require("./add-local.js")
  , realizePackageSpecifier = require("realize-package-specifier")
  , normalizeGitUrl = require("normalize-git-url")
  , randomBytes = require("crypto").pseudoRandomBytes // only need uniqueness

var remotes = path.resolve(npm.config.get("cache"), "_git-remotes")
var templates = path.join(remotes, "_templates")

var VALID_VARIABLES = [
  "GIT_SSH",
  "GIT_SSL_NO_VERIFY",
  "GIT_PROXY_COMMAND",
  "GIT_SSL_CAINFO"
]

// 1. cacheDir = path.join(cache,'_git-remotes',sha1(gitURL))
// 2. checkGitDir(cacheDir) ? 4. : 3. (rm cacheDir if necessary)
// 3. git clone --mirror gitURL cacheDir
// 4. cd cacheDir && git fetch -a origin
// 5. git rev-list -n1 treeish
// 6. git clone workingDir tmpDir
// 7. cd tmpDir && git checkout treeish
// 8. addLocal(tmpDir)
// 9. fix remote permissions
//
// silent flag is used if this should error quietly
module.exports = function addRemoteGit (gitURL, silent, cb) {
  assert(typeof gitURL === 'string', 'must have git URL')
  assert(typeof cb === 'function', 'must have callback')

  var normalized = normalizeGitUrl(gitURL)
  var strippedURL = normalized.url
  var treeish = normalized.branch
  var tmpPath = strippedURL.replace(/[^a-zA-Z0-9]+/g, '-') + '-' +
    crypto.createHash('sha1').update(strippedURL).digest('hex').slice(0, 8)
  var checkoutPath = path.join(remotes, tmpPath)
  var reconstitutedURL
  if (!/^git[+:]/.test(gitURL)) {
    reconstitutedURL = 'git+' + gitURL
  } else {
    reconstitutedURL = gitURL
  }
  var params = {
    silent: silent,
    gitURL: strippedURL,
    originalURL: reconstitutedURL,
    treeish: treeish,
    checkoutPath: checkoutPath
  }
  log.verbose('addRemoteGit', 'params', params)

  cb = inflight(checkoutPath, cb)
  if (!cb) {
    return log.verbose('addRemoteGit', checkoutPath, 'already in flight; waiting')
  }
  log.verbose('addRemoteGit', checkoutPath, 'not in flight; caching')

  getGitDir(function (er) {
    if (er) return cb(er)
    checkGitDir(params, function (er, data) {
      if (er) return cb(er, data)

      addModeRecursive(checkoutPath, npm.modes.file, function (er) {
        return cb(er, data)
      })
    })
  })
}

function checkGitDir (params, cb) {
  fs.stat(params.checkoutPath, function (er, s) {
    if (er) return cloneGitRemote(params, cb)
    if (!s.isDirectory()) return rm(params.checkoutPath, function (er) {
      if (er) return cb(er)
      cloneGitRemote(params, cb)
    })

    git.whichAndExec(
      ['config', '--get', 'remote.origin.url'],
      { cwd: params.checkoutPath, env: gitEnv() },
      function (er, stdout, stderr) {
        var originURL = (stdout + '\n' + stderr).trim()
        if (er || params.gitURL !== stdout.trim()) {
          log.warn(
            '`git config --get remote.origin.url` returned wrong result (' +
              params.gitURL + ')',
            originURL
          )
          return rm(params.checkoutPath, function (er) {
            if (er) return cb(er)
            cloneGitRemote(params, cb)
          })
        }

        log.verbose('checkGitDir', 'git remote.origin.url', originURL)
        fetchRemote(params, cb)
      }
    )
  })
}

function cloneGitRemote (params, cb) {
  mkdir(params.checkoutPath, function (er) {
    if (er) return cb(er)

    git.whichAndExec(
      ['clone', '--template=' + templates, '--mirror', params.gitURL, params.checkoutPath],
      { cwd: params.checkoutPath, env: gitEnv() },
      function (er, stdout, stderr) {
        stdout = (stdout + '\n' + stderr).trim()
        if (er) {
          if (params.silent) {
            log.verbose('git clone ' + params.gitURL, stdout)
          } else {
            log.error('git clone ' + params.gitURL, stdout)
          }
          return cb(er)
        }
        log.verbose('git clone ' + params.gitURL, stdout)
        fetchRemote(params, cb)
      }
    )
  })
}

function fetchRemote (params, cb) {
  git.whichAndExec(
    ['fetch', '-a', 'origin'],
    { cwd: params.checkoutPath, env: gitEnv() },
    function (er, stdout, stderr) {
      stdout = (stdout + '\n' + stderr).trim()
      if (er) {
        log.error('git fetch -a origin (' + params.gitURL + ')', stdout)
        return cb(er)
      }
      log.verbose('git fetch -a origin (' + params.gitURL + ')', stdout)

      if (process.platform === 'win32') {
        log.silly('fetchRemote', 'skipping chownr on Windows')
        resolveHead(params, cb)
      } else {
        getGitDir(function (er, cs) {
          if (er) {
            log.error('fetchRemote', 'could not get cache stat')
            return cb(er)
          }

          chownr(params.checkoutPath, cs.uid, cs.gid, function (er) {
            if (er) {
              log.error(
                'fetchRemote',
                'Failed to change folder ownership under npm cache for',
                params.checkoutPath
              )
              return cb(er)
            }

            resolveHead(params, cb)
          })
        })
      }
    }
  )
}

function resolveHead (params, cb) {
  log.verbose('resolveHead', 'original treeish', params.treeish)
  git.whichAndExec(
    ['rev-list', '-n1', params.treeish],
    { cwd: params.checkoutPath, env: gitEnv() },
    function (er, stdout, stderr) {
      params.exactTreeish = (stdout + '\n' + stderr).trim()
      if (er) {
        log.error('Failed resolving git HEAD (' + params.gitURL + ')', stderr)
        return cb(er)
      }
      log.verbose('resolveHead', 'resolved treeish', params.exactTreeish)

      params.resolved = getResolved(params.originalURL, params.exactTreeish)

      // generate a unique filename
      params.tmpdir = path.join(
        npm.tmp,
        'git-cache-' + randomBytes(6).toString('hex'),
        params.exactTreeish
      )
      log.silly('resolveHead', 'temporary clone directory', params.tmpdir)

      mkdir(params.tmpdir, function (er) {
        if (er) return cb(er)

        clone(params, cb)
      })
    }
  )
}

/**
 * Make an actual clone from the bare (mirrored) cache.
 */
function clone (params, cb) {
  git.whichAndExec(
    ['clone', params.checkoutPath, params.tmpdir],
    { cwd: params.checkoutPath, env: gitEnv() },
    function (er, stdout, stderr) {
      stdout = (stdout + '\n' + stderr).trim()
      if (er) {
        log.error('Failed to clone ' + params.resolved + ' from ' + params.gitURL, stderr)
        return cb(er)
      }
      log.verbose('clone', 'from', params.checkoutPath)
      log.verbose('clone', stdout)

      checkout(params, cb)
    }
  )
}

/**
 * There is no safe way to do a one-step clone to a treeish that isn't
 * guaranteed to be a branch, so explicitly check out the treeish once it's
 * cloned.
 */
function checkout (params, cb) {
  git.whichAndExec(
    ['checkout', params.exactTreeish],
    { cwd: params.tmpdir, env: gitEnv() },
    function (er, stdout, stderr) {
      stdout = (stdout + '\n' + stderr).trim()
      if (er) {
        log.error('Failed to check out ' + params.exactTreeish, stderr)
        return cb(er)
      }
      log.verbose('checkout', stdout)

      // convince addLocal that the checkout is a local dependency
      realizePackageSpecifier(params.tmpdir, function (er, spec) {
        if (er) {
          log.error('checkout', 'Failed to map', params.tmpdir, 'to a package specifier')
          return cb(er)
        }

        // https://github.com/npm/npm/issues/6400
        // ensure pack logic is applied
        addLocal(spec, null, function (er, data) {
          if (data) {
            log.verbose('checkout', 'data._resolved:', params.resolved)
            data._resolved = params.resolved

            if (!data._fromGitHub) {
              log.silly('checkout', 'data._from:', data._from, '(was ' + params.originalURL + ')')
              data._from = params.originalURL
            } else {
              log.silly('checkout', 'data._from:', data._from, '(GitHub)')
            }
          }

          cb(er, data)
        })
      })
    }
  )
}

function getGitDir (cb) {
  getCacheStat(function (er, stats) {
    if (er) return cb(er)

    // We don't need global templates when cloning. Use an empty directory for
    // the templates, creating it (and setting its permissions) if necessary.
    mkdir(templates, function (er) {
      if (er) return cb(er)

      // Ensure that both the template and remotes directories have the correct
      // permissions.
      fs.chown(templates, stats.uid, stats.gid, function (er) {
        if (er) return cb(er)

        fs.chown(remotes, stats.uid, stats.gid, function (er) {
          cb(er, stats)
        })
      })
    })
  })
}

var gitEnv_
function gitEnv () {
  // git responds to env vars in some weird ways in post-receive hooks
  // so don't carry those along.
  if (gitEnv_) return gitEnv_
  gitEnv_ = {}
  for (var k in process.env) {
    if (!~VALID_VARIABLES.indexOf(k) && k.match(/^GIT/)) continue
    gitEnv_[k] = process.env[k]
  }
  return gitEnv_
}

function getResolved (uri, treeish) {
  var parsed = url.parse(uri)
  parsed.hash = treeish
  if (!/^git[+:]/.test(parsed.protocol)) {
    parsed.protocol = 'git+' + parsed.protocol
  }
  var resolved = url.format(parsed)

  // https://github.com/npm/npm/issues/3224
  // node incorrectly sticks a / at the start of the path We know that the
  // host won't change, so split and detect this
  var spo = uri.split(parsed.host)
  var spr = resolved.split(parsed.host)
  if (spo[1].charAt(0) === ':' && spr[1].charAt(0) === '/') {
    spr[1] = spr[1].slice(1)
  }
  return spr.join(parsed.host)
}

// similar to chmodr except it add permissions rather than overwriting them
// adapted from https://github.com/isaacs/chmodr/blob/master/chmodr.js
function addModeRecursive(checkoutPath, mode, cb) {
  fs.readdir(checkoutPath, function (er, children) {
    // Any error other than ENOTDIR means it's not readable, or doesn't exist.
    // Give up.
    if (er && er.code !== "ENOTDIR") return cb(er)
    if (er || !children.length) return addMode(checkoutPath, mode, cb)

    var len = children.length
    var errState = null
    children.forEach(function (child) {
      addModeRecursive(path.resolve(checkoutPath, child), mode, then)
    })

    function then (er) {
      if (errState) return undefined
      if (er) return cb(errState = er)
      if (--len === 0) return addMode(checkoutPath, dirMode(mode), cb)
    }
  })
}

function addMode(checkoutPath, mode, cb) {
  fs.stat(checkoutPath, function (er, stats) {
    if (er) return cb(er)
    mode = stats.mode | mode
    fs.chmod(checkoutPath, mode, cb)
  })
}

// taken from https://github.com/isaacs/chmodr/blob/master/chmodr.js
function dirMode(mode) {
  if (mode & parseInt("0400", 8)) mode |= parseInt("0100", 8)
  if (mode & parseInt( "040", 8)) mode |= parseInt( "010", 8)
  if (mode & parseInt(  "04", 8)) mode |= parseInt(  "01", 8)
  return mode
}
