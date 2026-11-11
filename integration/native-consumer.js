import { verifyNativeProof } from '../src/native-edits.ts'

const MAX_RECORDS = 256
const MAX_UNITS = 2 * 1024 * 1024
const ORIGINS = new Set(['local', 'remote', 'undo', 'redo', 'reject'])
const PHASES = new Set(['none', 'intermediate', 'committed'])
const integer = value => Number.isSafeInteger(value) && value >= 0
const now = () => performance.timeOrigin + performance.now()
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

// Validate exact editor text independently of the more conservative proof helper.
// Unsupported proof shapes (e.g. a very large change) can still synchronize exact
// text, whereas a broken before/after chain must first recover a native snapshot.
function compactRecord(record, expectedId, before) {
  if (!record || record.transactionId !== expectedId || record.before !== before || typeof record.after !== 'string' ||
      !ORIGINS.has(record.origin) || !Array.isArray(record.changes) || !record.composition ||
      !PHASES.has(record.composition.phase) || !(record.composition.id === null || integer(record.composition.id) && record.composition.id > 0)) {
    throw Error('Native record identity or before-state differs')
  }
  let cursor = 0, delta = 0, units = 0
  const parts = [], changes = []
  for (const change of record.changes) {
    if (!change || ![change.fromA, change.toA, change.fromB, change.toB].every(integer) ||
        change.fromA < cursor || change.toA < change.fromA || change.toA > before.length ||
        typeof change.inserted !== 'string' || typeof change.removed !== 'string' ||
        before.slice(change.fromA, change.toA) !== change.removed || change.fromB !== change.fromA + delta ||
        change.toB !== change.fromB + change.inserted.length) throw Error('Native change coordinates differ')
    parts.push(before.slice(cursor, change.fromA), change.inserted)
    cursor = change.toA
    delta += change.inserted.length - (change.toA - change.fromA)
    units += change.inserted.length + change.removed.length
    changes.push({ fromA: change.fromA, toA: change.toA, fromB: change.fromB, toB: change.toB, inserted: change.inserted, removed: change.removed })
  }
  parts.push(before.slice(cursor))
  if (parts.join('') !== record.after) throw Error('Native changes do not reproduce after-state')
  return { units: units + changes.length * 32 + 64, step: freeze({ transactionId: record.transactionId, beforeLength: before.length, afterLength: record.after.length,
    origin: record.origin, changes, composition: { id: record.composition.id, phase: record.composition.phase } }) }
}

/** Read-only single-epoch consumer. All source synchronization belongs to callers. */
export function createNativeConsumer(callbacks = {}) {
  let active = null, unsubscribe = null, stopped = false, processing = false, inbox = [], inboxOverflow = false
  const report = (tracker, code, error) => {
    try { (tracker?.callbacks.onError ?? callbacks.onError)?.({ code, error, docId: tracker?.docId ?? null, viewEpoch: tracker?.epoch ?? null }) } catch {}
  }
  const callback = (tracker, name, payload) => {
    try { tracker.callbacks[name]?.(freeze(payload)) } catch (error) { report(tracker, 'callback-failed', error) }
  }
  const dropProof = (tracker, reason) => {
    tracker.pending = []; tracker.units = 0; tracker.proofAvailable = false
    tracker.resyncReason = reason; tracker.proofRevision++
  }
  const proofFor = (tracker, through = tracker.latestId, text = tracker.text) => {
    const proof = { version: 1, coordinateSpace: 'codemirror-utf16', viewEpoch: tracker.epoch,
      baseTransactionId: tracker.baseId, transactionId: through,
      records: tracker.pending.filter(entry => entry.step.transactionId <= through).map(entry => entry.step) }
    verifyNativeProof(tracker.baseText, text, proof)
    return freeze(proof)
  }
  const allowAck = tracker => {
    tracker.ackEndpoints.add(tracker.latestId)
    while (tracker.ackEndpoints.size > MAX_RECORDS + 1) tracker.ackEndpoints.delete(tracker.ackEndpoints.values().next().value)
  }
  const compositionState = tracker => ({ id: tracker.open.size ? Math.max(...tracker.open) : null, phase: tracker.open.size ? 'active' : 'none' })
  const updateCompletion = (tracker, message) => {
    if (!integer(message.completedThroughCompositionId)) throw Error('Invalid native composition watermark')
    tracker.completed = Math.max(tracker.completed, message.completedThroughCompositionId)
    for (const id of tracker.open) if (id <= tracker.completed) tracker.open.delete(id)
  }
  const snapshotComposition = (tracker, composition) => {
    if (!composition || !['active', 'ending', 'none'].includes(composition.phase) ||
        !(composition.id === null || integer(composition.id) && composition.id > 0) ||
        (composition.phase === 'none') !== (composition.id === null)) throw Error('Invalid native composition snapshot')
    tracker.open.clear()
    if (composition.id !== null && composition.id > tracker.completed) tracker.open.add(composition.id)
  }
  const maybeCommit = tracker => {
    if (active !== tracker || tracker.stopped || tracker.recovering || tracker.open.size || !tracker.dirty || tracker.latestId === null) return
    allowAck(tracker)
    let proof = null
    if (tracker.acked && tracker.proofAvailable) {
      try { proof = proofFor(tracker) } catch (error) { dropProof(tracker, 'unsupported-proof'); report(tracker, 'proof-downgraded', error) }
    }
    const resync = proof === null
    const key = `${tracker.latestId}:${tracker.baseId}:${tracker.proofRevision}:${resync}`
    if (key === tracker.lastCommitKey) return
    tracker.lastCommitKey = key
    callback(tracker, 'onCommit', { text: tracker.text, proof, transactionId: tracker.latestId, viewEpoch: tracker.epoch,
      docId: tracker.docId, inputAt: tracker.inputAt ?? now(), resync,
      resyncReason: resync ? tracker.resyncReason ?? 'unacknowledged-baseline' : null })
  }
  const requestRecovery = (tracker, reason, forceSnapshot = false) => {
    if (active !== tracker || tracker.stopped) return
    if (tracker.recovering === 'snapshot') { report(tracker, 'native-recovery-failed', Error(reason)); return }
    const snapshot = forceSnapshot || tracker.recovering === 'replay' || tracker.latestId === null
    tracker.recovering = snapshot ? 'snapshot' : 'replay'
    if (snapshot) dropProof(tracker, reason)
    window.dispatchEvent(new CustomEvent('rtex:native:replay', { detail: {
      viewEpoch: tracker.epoch, afterTransactionId: snapshot ? Number.MAX_SAFE_INTEGER : tracker.latestId,
    } }))
  }
  const acceptRecords = (tracker, message) => {
    if (!Array.isArray(message.records) || !integer(message.transactionId) || tracker.latestId === null) throw Error('Native transaction batch has no baseline')
    const receivedAt = now()
    for (const record of message.records) {
      if (!integer(record?.transactionId)) throw Error('Invalid native transaction ID')
      if (record.transactionId <= tracker.latestId) continue // replay/broadcast deduplication
      const compact = compactRecord(record, tracker.latestId + 1, tracker.text)
      tracker.text = record.after; tracker.latestId = record.transactionId
      tracker.dirty = true; tracker.inputAt ??= receivedAt
      if (compact.step.composition.id !== null && compact.step.composition.id > tracker.completed) tracker.open.add(compact.step.composition.id)
      if (tracker.proofAvailable) {
        if (compact.step.changes.length > 4096) dropProof(tracker, 'unsupported-proof-shape')
        else if (tracker.pending.length >= MAX_RECORDS || tracker.units + compact.units > MAX_UNITS) dropProof(tracker, 'pending-journal-overflow')
        else { tracker.pending.push({ ...compact, inputAt: receivedAt }); tracker.units += compact.units }
      }
    }
    if (message.transactionId !== tracker.latestId) throw Error('Native transaction endpoint differs')
  }
  const acceptSnapshot = (tracker, message) => {
    if (!integer(message.transactionId) || typeof message.text !== 'string') throw Error('Invalid native snapshot')
    if (tracker.latestId !== null && message.transactionId < tracker.latestId) throw Error('Native snapshot moved backward')
    const initial = tracker.latestId === null
    const same = !initial && message.transactionId === tracker.latestId && message.text === tracker.text
    snapshotComposition(tracker, message.composition)
    if (initial) {
      tracker.baseId = message.transactionId; tracker.baseText = message.text
      tracker.proofAvailable = true
    } else if (!same || message.reason === 'journal-gap' || tracker.recovering === 'snapshot') {
      dropProof(tracker, message.reason === 'journal-gap' ? 'native-journal-gap' : 'snapshot-resync')
      tracker.dirty = true; tracker.inputAt ??= now()
    }
    tracker.text = message.text; tracker.latestId = message.transactionId; tracker.recovering = null
    if (tracker.open.size) tracker.dirty = true
    else allowAck(tracker)
    callback(tracker, 'onSnapshot', { text: tracker.text, transactionId: tracker.latestId, viewEpoch: tracker.epoch, docId: tracker.docId,
      reason: message.reason, composition: compositionState(tracker), resync: !tracker.acked || !tracker.proofAvailable,
      resyncReason: tracker.resyncReason ?? (!tracker.acked ? 'unacknowledged-baseline' : null), initial })
    maybeCommit(tracker)
  }
  const processMessage = message => {
    const tracker = active
    if (!tracker || tracker.stopped || message?.viewEpoch !== tracker.epoch || message.docId !== tracker.docId) return
    if (message.version !== 1 || message.coordinateSpace !== 'codemirror-utf16' || !integer(message.sequence) || message.sequence < 1) {
      report(tracker, 'invalid-native-envelope', Error('Invalid native envelope')); return
    }
    if (message.sequence <= tracker.sequence) return
    const sequenceGap = tracker.sequence !== 0 && message.sequence !== tracker.sequence + 1
    tracker.sequence = message.sequence
    if (message.kind === 'destroy') {
      tracker.stopped = true; active = null; tracker.pending = []; tracker.baseText = tracker.text = ''
      callback(tracker, 'onSnapshot', { reason: 'destroy', docId: tracker.docId, viewEpoch: tracker.epoch, transactionId: tracker.latestId, resync: true })
      return
    }
    if (sequenceGap && message.kind !== 'snapshot') { requestRecovery(tracker, 'event-sequence-gap'); return }
    try {
      updateCompletion(tracker, message)
      if (message.kind === 'snapshot') { acceptSnapshot(tracker, message); return }
      if (message.kind === 'transactions' || message.kind === 'replay') {
        acceptRecords(tracker, message)
        if (message.kind === 'replay') { snapshotComposition(tracker, message.composition); tracker.recovering = null }
        maybeCommit(tracker)
      } else if (message.kind === 'composition') {
        if (!integer(message.id) || message.id < 1 || message.transactionId !== tracker.latestId || !['start', 'update', 'end'].includes(message.phase)) throw Error('Invalid native composition event')
        if (message.phase === 'end') {
          if (message.transactionId !== tracker.latestId || message.text !== tracker.text) throw Error('Composition end source differs')
          if (message.id > tracker.completed) throw Error('Composition end lacks completion watermark')
        } else if (message.id > tracker.completed) tracker.open.add(message.id)
        maybeCommit(tracker)
      } else throw Error('Unsupported native message kind')
    } catch (error) {
      report(tracker, 'native-chain-mismatch', error)
      requestRecovery(tracker, 'native-chain-mismatch')
    }
  }
  const listener = event => {
    if (stopped) return
    if (inbox.length >= 4) { inbox = []; inboxOverflow = true }
    inbox.push(event.detail)
    if (processing) return
    processing = true
    try {
      while (inbox.length) {
        processMessage(inbox.shift())
        if (inboxOverflow && active) { inboxOverflow = false; requestRecovery(active, 'consumer-event-overflow', true) }
      }
    } finally { processing = false }
  }
  const subscribe = () => {
    if (unsubscribe || stopped) return !!unsubscribe
    window.dispatchEvent(new CustomEvent('rtex:native:subscribe', { detail: {
      listener, onRegistered(dispose) { if (typeof dispose === 'function') unsubscribe = dispose },
    } }))
    return !!unsubscribe
  }
  const stopTracker = tracker => {
    tracker.stopped = true; tracker.pending = []; tracker.units = 0; tracker.baseText = tracker.text = ''
    if (active === tracker) active = null
  }
  const newTracker = (identity, overrides) => {
    const tracker = { epoch: identity.viewEpoch, docId: identity.docId, callbacks: { ...callbacks, ...overrides },
      stopped: false, sequence: 0, latestId: null, text: '', baseId: null, baseText: '', acked: false,
      proofAvailable: false, proofRevision: 0, resyncReason: null, pending: [], units: 0,
      open: new Set(), completed: 0, ackEndpoints: new Set(), recovering: null, dirty: false, inputAt: null, lastCommitKey: null }
    tracker.binding = Object.freeze({ epoch: tracker.epoch, viewEpoch: tracker.epoch, docId: tracker.docId,
      get active() { return active === tracker && !tracker.stopped },
      ack(transactionId, text) {
        if (active !== tracker || tracker.stopped || !integer(transactionId) || typeof text !== 'string' || !tracker.ackEndpoints.has(transactionId) || transactionId < tracker.baseId) return false
        try {
          if (transactionId === tracker.latestId && text === tracker.text) {
            tracker.baseId = transactionId; tracker.baseText = text; tracker.pending = []; tracker.units = 0
            tracker.proofAvailable = true; tracker.acked = true; tracker.resyncReason = null
            tracker.ackEndpoints = new Set([transactionId])
            tracker.dirty = false; tracker.inputAt = null; tracker.proofRevision++
            return true
          }
          if (transactionId === tracker.baseId && text === tracker.baseText) { tracker.acked = true; maybeCommit(tracker); return true }
          if (!tracker.proofAvailable) return false
          proofFor(tracker, transactionId, text)
          tracker.baseId = transactionId; tracker.baseText = text; tracker.acked = true
          for (const id of tracker.ackEndpoints) if (id < transactionId) tracker.ackEndpoints.delete(id)
          tracker.pending = tracker.pending.filter(entry => entry.step.transactionId > transactionId)
          tracker.units = tracker.pending.reduce((sum, entry) => sum + entry.units, 0)
          tracker.inputAt = tracker.pending[0]?.inputAt ?? null
          maybeCommit(tracker)
          return true
        } catch (error) { report(tracker, 'acknowledgment-mismatch', error); return false }
      },
      stop() { stopTracker(tracker) },
      // Text-free diagnostics make retention limits observable without exposing state.
      get status() { return Object.freeze({ pendingRecords: tracker.pending.length, pendingUnits: tracker.units, proofAvailable: tracker.proofAvailable && tracker.acked,
        latestTransactionId: tracker.latestId, acknowledgedTransactionId: tracker.acked ? tracker.baseId : null, compositionPending: tracker.open.size > 0 }) },
    })
    return tracker
  }
  return Object.freeze({
    bind(editorState, docId, overrides = {}) {
      if (stopped || typeof docId !== 'string' || !docId || !subscribe()) return null
      let binding = null
      window.dispatchEvent(new CustomEvent('rtex:native:bind', { detail: { editorState,
        onBound(identity) {
          if (!identity || identity.docId !== docId || typeof identity.viewEpoch !== 'string' || !/^rtex-view-\d+$/.test(identity.viewEpoch)) return
          if (active?.epoch === identity.viewEpoch && active.docId === docId) { binding = active.binding; return }
          if (active) stopTracker(active)
          active = newTracker(identity, overrides) // before native bind emits its synchronous snapshot
          binding = active.binding
        },
      } }))
      if (!binding && !active) { unsubscribe?.(); unsubscribe = null }
      return binding
    },
    stop() {
      if (stopped) return
      stopped = true
      if (active) stopTracker(active)
      unsubscribe?.(); unsubscribe = null; inbox = []
    },
  })
}
