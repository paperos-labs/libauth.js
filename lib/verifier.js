"use strict";

let crypto = require("crypto");

let E = require("./errors.js");
let rnd = require("./rnd.js");
let parseDuration = require("./parse-duration.js");

/** @param {import('express').Request} req */
async function _notify(req) {}

/**
 * @typedef challenge
 * @property {string} id
 * @property {string} [receipt]
 * @property {string} [code]
 * @property {string} [type]
 * @property {string} [value]
 * @property {number} [attempts]
 * @property {string} [expires_at]
 * @property {string} [canceled_at]
 * @property {string} [canceled_by]
 * @property {string} [canceled_ip]
 * @property {string} [ordered_at]
 * @property {string} [ordered_by]
 * @property {string} [ordered_ip]
 * @property {string} [iss]
 * @property {string} [_max_age]
 */

var C = module.exports;

C.create = function ({
  // important
  iss = "",
  secret = "",
  notify = _notify,
  /** @type {import('./memory-store.js').MemoryStore} */
  //@ts-ignore
  store,

  // optional
  coolDownMs = 250,
  idByteCount = 4,
  /** @type {import('crypto').BinaryToTextEncoding} */
  idEncoding = "base64",
  maxAge = "24h",
  maxAttempts = 5,
  receiptByteCount = 16,
  /** @type {import('crypto').BinaryToTextEncoding} */
  receiptEncoding = "base64",
  authnParam = "authn", // TODO use same name as elsewhere
}) {
  // TODO document: 300s, 5m, 12h, 30d
  let maxAgeMs = parseDuration(maxAge);
  let HMAC_SECRET = secret;

  let Challenge = {};

  /**
   * @param {{
   *   type: String,
   *   value: String,
   * }} identifier
   * @param {import('express').Request} req
   * @param {any} opts
   * @returns {challenge}
   */
  Challenge.create = function (identifier, req, opts) {
    let ua = req.headers["user-agent"];
    let ip = req.ip;
    if ("email" === identifier.type) {
      // normalize email
      identifier.value = (identifier.value || "").trim().toLowerCase();
    }

    if (!identifier.value) {
      throw E.DEVELOPER_ERROR(
        "'value' (the email/phone/contact) is missing from the request body"
      );
    }

    // Security: HMAC_SECRET MUST be at least 12 bytes (96-bits).
    //
    // With that assumed, we can drop the number of required bits
    // for the code down in the range of 29~32 bits,possibly lower
    // if the number of attempts is capped below 10, and/or the time
    // window is shrunk from 20 minutes to 10m or 5m
    //
    // https://therootcompany.com/blog/how-many-bits-of-entropy-per-character/
    let { code, receipt, id } = Challenge._rndCode(4, "hex");

    let d = new Date();
    let _maxAge = opts.maxAge || maxAge;
    let expiration = new Date(d.valueOf() + parseDuration(_maxAge));
    /** @type challenge */
    let c = {
      id: id,
      receipt: receipt, //
      code: code,
      type: identifier.type,
      value: identifier.value,
      attempts: 0,
      expires_at: expiration.toISOString(), //
      ordered_at: d.toISOString(),
      ordered_by: ua,
      ordered_ip: ip,
      iss: opts.iss || iss, //
      _max_age: maxAge,
    };

    return c;
  };

  /**
   * Sanitizes and returns challenge object
   * @param {string} id
   */
  Challenge.get = async function (id) {
    let c = await store.get(id);
    Object.keys(c).forEach(function (k) {
      if ("_" === k[0]) {
        c[k] = undefined;
      }
    });
    return c;
  };

  /**
   * Will sanitize and save the challenge object
   * @param {string} id
   * @param {any} c
   */
  Challenge.set = async function (id, c) {
    if ("undefined" !== typeof c.code) {
      c.code = undefined;
    }
    Object.keys(c).forEach(function (k) {
      if ("_" === k[0] && "undefined" !== typeof c[k]) {
        c[k] = undefined;
      }
    });
    await store.set(id, c);
  };

  /**
   * @param {challenge} c
   * @param {import('express').Request} req
   * @param {any} opts
   * @returns {Promise<void>}
   */
  Challenge.notify = async function (c, req, opts) {
    // TODO consider built-in redirect
    //challenge_redirect: `${iss}/login/?id=xxxx&code=yyyy&redirect=${iss}/login/`
    //@ts-ignore
    req[authnParam] = {
      strategy: "challenge",
      type: c.type, // email
      value: c.value, // john.doe@gmail.com
      userAgent: c.ordered_by,
      code: c.code,
      id: c.id,
      issuer: opts.iss || iss,
      iss: opts.iss || iss,
    };
    await notify(req);
    //@ts-ignore
    req[authnParam] = null;
  };

  /** @type {Object.<string, boolean>} */
  let attempts = {};

  /**
   * Handles the mutex-y bits of the attempt counter / cool-off-er
   * @param {string} id
   * @param {string} [code]
   * @param {import('express').Request} [req]
   * @returns {Promise<challenge>}
   */
  Challenge.check = async function (id, code = "", req = undefined) {
    if (!id) {
      throw E.DEVELOPER_ERROR("'id' is missing from the query parameters");
    }

    let c = await Challenge.get(id);
    if (!c || !Challenge._isFresh(c)) {
      throw E.CODE_INVALID();
    }

    if (code) {
      await Challenge._check(id, c, code);
      return c;
    }

    return c;
  };

  /**
   * Increment on failure, mark verified (redeem) on success.
   * @param {string} id
   * @param {string} code
   * @param {import('express').Request} req
   */
  Challenge.redeem = async function (id, code, req) {
    let c = await Challenge.get(id);

    // TODO stale can see status, expired cannot?
    if (c && c.verified_at) {
      throw E.CODE_REDEEMED();
    }

    await Challenge._check(id, c, code);

    c.verified_at = new Date().toISOString();
    c.verified_by = req.headers["user-agent"];
    c.verified_ip = req.ip;
    await store.set(id, c);

    return c;
  };

  /**
   * @param {string} id
   * @param {string} receipt
   * @param {import('express').Request} req
   * @returns {Promise<challenge>}
   */
  Challenge.exchange = async function (id, receipt, req) {
    let c = await Challenge.get(id);

    if (c && c.exchanged_at) {
      throw E.CODE_REDEEMED();
    }

    if (!c || !Challenge._isFresh(c)) {
      throw E.CODE_INVALID();
    }

    if (!c.verified_at) {
      // TODO better message and error code
      throw E.DEVELOPER_ERROR(
        "a challenge code exchange was requested before the challenge code was submitted"
      );
    }

    let exchanged_by = req.headers["user-agent"];
    // TODO ip address should consider 'trust proxy', 'x-forwarded-for', etc
    // It's probably more likely that the WiFi might change than that
    // an attacker has the same token at a different IP address
    //let exchanged_ip = req.ip;
    if (c.ordered_by !== exchanged_by /*|| c.ordered_ip !== exchanged_ip*/) {
      throw E.SUSPICIOUS_REQUEST();
    }

    c.exchanged_at = new Date().toISOString();
    // TODO audit log
    await Challenge.set(id, c);

    return c;
  };

  /**
   * @param {string} id
   * @param {import('express').Request} req
   * @returns {Promise<challenge>}
   */
  Challenge.cancel = async function (id, req) {
    let c = await Challenge.get(id);
    if (!c || !Challenge._isFresh(c)) {
      throw E.CODE_INVALID();
    }

    c.canceled_at = new Date().toISOString();
    c.canceled_by = req.headers["user-agent"];
    c.canceled_ip = req.ip;

    await store.set(id, c);
    //await Challenge.set(id, c);

    return c;
  };

  /**
   * @param {{
   *   iss: String,
   *   secret: String,
   *   authnParam: String,
   * }} opts
   */
  Challenge.setDefaults = function (opts) {
    if (!iss && opts.iss) {
      iss = opts.iss;
    }
    if (!secret && opts.secret) {
      secret = opts.secret;
    }
    if (!authnParam && opts.authnParam) {
      authnParam = opts.authnParam;
    }
  };

  /**
   * Handles the mutex-y bits of the attempt counter / cool-off-er
   * @param {string} id
   * @param {challenge} c
   * @param {string} code
   */
  Challenge._check = async function (id, c, code) {
    // An attacker could grant himself hundreds or thousands of extra attempts
    // by firing off many requests in parallel - the database might read
    // `attempts = 0` 1000 times and then write `attempts = 1` 1000 times, and
    // then repeat for `attempts = 1`, etc.
    //
    // To prevent this disallow parallel requests.
    // (note: a scalable server system will need a more sophisticated approach)
    if (attempts[id]) {
      await C._sleep(coolDownMs);
      throw E.ENHANCE_YOUR_CALM();
    }

    attempts[id] = true;
    await Challenge._incrementOnFailure(c, code).catch(Error);

    // always delete the attempt
    delete attempts[id];
    if (c instanceof Error) {
      throw c;
    }

    return c;
  };

  /**
   * Increments `attempts` on failure.
   * @param {challenge} c
   * @param {string} code
   */
  Challenge._incrementOnFailure = async function (c, code) {
    if (!c || !Challenge._isFresh(c)) {
      throw E.CODE_INVALID();
    }

    let success = C._codesMatch(
      HMAC_SECRET,
      c.receipt || "",
      code,
      receiptByteCount,
      receiptEncoding
    );
    if (!success) {
      // tracking attempts is the sole reason for using an ID
      // rather than just the receipt and secret verification code
      if (!c.attempts) {
        c.attempts = 0;
      }
      c.attempts += 1;
      await store.set(c.id, c);
      throw E.CODE_RETRY();
    }

    return c;
  };

  /**
   * @param {any} c
   * @returns {boolean}
   */
  // TODO c should maintain maxAgeMs, etc
  Challenge._isFresh = function (c) {
    return C._isFresh(c, maxAgeMs, maxAttempts);
  };

  /**
   * @param {number} bytes
   * @param {BufferEncoding} enc
   */
  Challenge._rndCode = function (bytes, enc) {
    let code = rnd(bytes, enc);
    let receipt = C._hashify(
      HMAC_SECRET,
      code,
      receiptByteCount,
      receiptEncoding
    );
    let id = C._hashify(HMAC_SECRET, receipt, idByteCount, idEncoding);

    return { code, receipt, id };
  };

  return Challenge;
};

C._sleep = async function sleep(n = 0) {
  return await new Promise(function (resolve) {
    setTimeout(resolve, n);
  });
};

/**
 * @param {string} HMAC_SECRET
 * @param {string} receipt
 * @param {string} userCode
 * @param {number} bytes
 * @param {string} enc
 */
C._codesMatch = function (HMAC_SECRET, receipt, userCode, bytes, enc) {
  let a = receipt;
  let b = C._hashify(HMAC_SECRET, userCode, bytes, enc);

  if (!a || !b || String(a).length !== String(b).length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

/**
 * @param {string} HMAC_SECRET
 * @param {string} code
 * @param {number} bytes
 * @param {string} enc
 * @param {import('crypto').BinaryToTextEncoding} enc
 */
C._hashify = function (HMAC_SECRET, code, bytes, enc) {
  if (!code) {
    // Just a non-false-y string that can't be base64
    return "[BAD SECRET -- DOESN'T EXIST]";
  }

  // How many bits of entropy will be how many encoded characters?
  // See https://therootcompany.com/blog/how-many-bits-of-entropy-per-character/
  let ratio = 2;
  if (!bytes) {
    bytes = 16; // 128-bits
  }
  if (!enc) {
    enc = "base64";
  }
  if ("base64" === enc) {
    ratio = 4 / 3;
  }
  return (
    crypto
      .createHash("sha256")
      .update(Buffer.from(`${HMAC_SECRET}:${code}`, "utf8"))
      //@ts-ignore
      .digest(enc)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "")
      // base64 to byte conversion
      .slice(0, Math.ceil(bytes * ratio))
  );
};

/**
 * @param {Challenge} c
 * @param {number} maxAgeMs
 * @param {number} maxAttempts
 */
C._isFresh = function (c, maxAgeMs, maxAttempts) {
  if (
    c.canceled_at ||
    c.deleted_at ||
    c.exchanged_at ||
    c.attempts >= maxAttempts
  ) {
    return false;
  }
  let now = Date.now();
  let d = new Date(c.ordered_at).valueOf();
  return now - d < maxAgeMs;
};