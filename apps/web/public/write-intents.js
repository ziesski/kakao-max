// One requestId per intended action, kept until its outcome is known.
//
// The daemon replays a write that arrives again with the same requestId and arguments instead of
// performing it twice. So the page picks the requestId, not the server, and keeps it:
//  - done, or definitely not done (refused, invalid): forget it; the next action gets a new one.
//  - outcome unknown (connection lost, timeout, *_OUTCOME_UNKNOWN) or waiting for approval: keep it,
//    so trying the same action again asks the daemon about the same request, never a second one.
// Loaded as a classic script by the page (window.KakaoWrites) and imported by the unit test.
(function (root) {
  function isUncertain(err) {
    return Boolean(err && err.uncertain);
  }
  /** 'done' | 'uncertain' | 'approval' | 'failed' for a settled call's error (undefined = success). */
  function outcomeOf(err) {
    if (!err) return 'done';
    if (isUncertain(err)) return 'uncertain';
    if (err.code === 'APPROVAL_REQUIRED') return 'approval';
    return 'failed';
  }

  function WriteIntents(makeId) {
    this.makeId = makeId || (() => root.crypto.randomUUID());
    this.ids = new Map();
  }
  /** The requestId for this exact action (same kind and arguments → same id until settled). */
  WriteIntents.prototype.idFor = function (key) {
    let id = this.ids.get(key);
    if (!id) {
      id = this.makeId();
      this.ids.set(key, id);
    }
    return id;
  };
  /** Record the result: keeps the id after an unknown outcome or a pending approval. Returns the outcome. */
  WriteIntents.prototype.settle = function (key, err) {
    const outcome = outcomeOf(err);
    if (outcome === 'done' || outcome === 'failed') this.ids.delete(key);
    return outcome;
  };
  WriteIntents.prototype.has = function (key) {
    return this.ids.has(key);
  };

  /** A stable key for an action and its exact arguments. */
  function intentKey(kind, args) {
    return kind + '\n' + JSON.stringify(args);
  }

  root.KakaoWrites = { WriteIntents, intentKey, outcomeOf, isUncertain };
})(globalThis);
