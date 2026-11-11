import { Transaction, type Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import { trackChangesAnnotation } from './realtime'

// This observer deliberately has no reference to ShareDoc or the OT adapters.
const DATA = 'rtex:native:data'
const SUBSCRIBE = 'rtex:native:subscribe'
const REPLAY = 'rtex:native:replay'
const BIND = 'rtex:native:bind'
const MAX_RECORDS = 256
const MAX_UNITS = 2 * 1024 * 1024 // retained UTF-16 code units, not network bytes
let nextEpoch = 0
let installed = false
const listeners = new Set<EventListener>()
const sessions = new Set<NativeSession>()

type Change = {
  fromA: number
  toA: number
  fromB: number
  toB: number
  inserted: string
  removed: string
}
type RecordEntry = {
  transactionId: number
  before: string
  after: string
  changes: Change[]
  origin: 'local' | 'remote' | 'undo' | 'redo' | 'reject'
  userEvent: string | null
  composition: { id: number | null; phase: 'none' | 'intermediate' | 'committed' }
}
type Subscribe = {
  listener: EventListener
  onRegistered: (unsubscribe: () => void) => void
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function install() {
  if (installed) return
  installed = true
  window.addEventListener(SUBSCRIBE, event => {
    const request = (event as CustomEvent<Subscribe>).detail
    if (typeof request?.listener !== 'function' || typeof request.onRegistered !== 'function') return
    // Each subscription owns a wrapper, so two subscriptions for the same callback
    // may be independently disposed without detaching one another.
    const listener: EventListener = event => request.listener(event)
    listeners.add(listener)
    window.addEventListener(DATA, listener)
    let active = true
    const unsubscribe = () => {
      if (!active) return
      active = false
      window.removeEventListener(DATA, listener)
      listeners.delete(listener)
      if (listeners.size === 0) for (const session of sessions) session.clearJournal()
    }
    try {
      request.onRegistered(unsubscribe)
    } catch {
      unsubscribe()
      return
    }
    if (active) for (const session of sessions) session.snapshot('subscribe')
  })
  window.addEventListener(BIND, event => {
    if (!listeners.size) return
    const request = (event as CustomEvent).detail
    if (typeof request?.onBound !== 'function') return
    NativeSession.bindState(request.editorState, request.onBound)
  })
  window.addEventListener(REPLAY, event => {
    if (!listeners.size) return
    const request = (event as CustomEvent).detail
    if (!request || typeof request.viewEpoch !== 'string' || !Number.isSafeInteger(request.afterTransactionId) || request.afterTransactionId < 0) return
    for (const session of sessions) {
      if (session.viewEpoch === request.viewEpoch) session.replay(request.afterTransactionId)
    }
  })
}

class NativeSession {
  readonly viewEpoch = `rtex-view-${++nextEpoch}`
  private sequence = 0
  private transactionId = 0
  private compositionId = 0
  private completedThroughCompositionId = 0
  private activeComposition: number | null = null
  private endingComposition: number | null = null
  private endTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private journal: RecordEntry[] = []
  private journalUnits = 0
  private droppedThrough = 0
  private compositionFirst: number | null = null
  private compositionLast: number | null = null

  constructor(private readonly view: EditorView, readonly docId: string) {
    sessions.add(this)
    this.snapshot('mount')
  }

  private matchesState(state: unknown) {
    return !this.destroyed && this.view.state === state
  }

  static bindState(state: unknown, onBound: (identity: Readonly<{ docId: string; viewEpoch: string }> | null) => void) {
    const matches = [...sessions].filter(session => session.matchesState(state))
    const session = matches.length === 1 ? matches[0] : null
    try {
      onBound(session ? freeze({ docId: session.docId, viewEpoch: session.viewEpoch }) : null)
    } catch {
      return
    }
    if (session) session.snapshot('bind')
  }

  private emit(kind: string, fields: object) {
    if (!listeners.size) return
    window.dispatchEvent(new CustomEvent(DATA, {
      detail: freeze({
        version: 1, kind, docId: this.docId, viewEpoch: this.viewEpoch,
        sequence: ++this.sequence, coordinateSpace: 'codemirror-utf16',
        completedThroughCompositionId: this.completedThroughCompositionId,
        ...fields,
      }),
    }))
  }

  private journalStatus() {
    return {
      firstTransactionId: this.journal[0]?.transactionId ?? null,
      lastTransactionId: this.journal.at(-1)?.transactionId ?? null,
      droppedThroughTransactionId: this.droppedThrough,
      maxRecords: MAX_RECORDS, maxUnits: MAX_UNITS,
    }
  }

  clearJournal() {
    this.journal = []
    this.journalUnits = 0
    this.droppedThrough = this.transactionId
  }

  snapshot(reason: string) {
    if (!listeners.size) return
    // Initial and late-subscription baselines can be captured mid-composition,
    // before this observer sees another input transaction or composition event.
    if (this.view.composing && this.activeComposition === null && this.endingComposition === null) {
      this.activeComposition = ++this.compositionId
      this.compositionFirst = this.compositionLast = null
    }
    this.emit('snapshot', {
      reason, text: this.view.state.doc.toString(), transactionId: this.transactionId,
      composition: { id: this.activeComposition ?? this.endingComposition, phase: this.activeComposition !== null ? 'active' : this.endingComposition !== null ? 'ending' : 'none' },
      journal: this.journalStatus(),
    })
  }

  replay(after: number) {
    if (after > this.transactionId || after < this.droppedThrough) {
      this.snapshot('journal-gap')
      return
    }
    this.emit('replay', { composition: { id: this.activeComposition ?? this.endingComposition, phase: this.activeComposition !== null ? 'active' : this.endingComposition !== null ? 'ending' : 'none' }, records: this.journal.filter(record => record.transactionId > after), transactionId: this.transactionId, journal: this.journalStatus() })
  }

  private retain(record: RecordEntry) {
    const units = record.before.length + record.after.length + record.changes.reduce((sum, change) => sum + change.inserted.length + change.removed.length, 0)
    // An oversized transaction is delivered exactly, but not retained. A replay
    // across it must explicitly resynchronize, never silently truncate a chain.
    if (units > MAX_UNITS) {
      this.clearJournal()
      return
    }
    this.journal.push(record)
    this.journalUnits += units
    while (this.journal.length > MAX_RECORDS || this.journalUnits > MAX_UNITS) {
      const old = this.journal.shift()!
      this.journalUnits -= old.before.length + old.after.length + old.changes.reduce((sum, change) => sum + change.inserted.length + change.removed.length, 0)
      this.droppedThrough = old.transactionId
    }
  }

  update(update: ViewUpdate) {
    // A ViewUpdate can contain several transactions, including mixed origins.
    // Never use update.changes or return early when one transaction is remote.
    if (!listeners.size) {
      this.transactionId += update.transactions.filter(transaction => transaction.docChanged).length
      this.clearJournal()
      return
    }
    const records: RecordEntry[] = []
    for (const transaction of update.transactions) {
      if (!transaction.docChanged) continue
      const userEvent = transaction.annotation(Transaction.userEvent) ?? null
      const origin = transaction.annotation(Transaction.remote) ? 'remote'
        : userEvent === 'undo' ? 'undo'
          : transaction.annotation(trackChangesAnnotation) === 'reject' ? 'reject'
            : userEvent === 'redo' ? 'redo' : 'local'
      // A reconfigured observer can mount after compositionstart. Recover an
      // active ID from CM's composition flag rather than calling it committed.
      if (origin === 'local' && transaction.isUserEvent('input.type.compose') &&
          this.activeComposition === null && this.endingComposition === null && this.view.composing) {
        this.compositionStart()
      }
      const composingInput = origin === 'local' && (
        transaction.isUserEvent('input.type.compose') ||
        (this.activeComposition !== null && transaction.isUserEvent('input.type'))
      )
      const composition = composingInput
        ? { id: this.activeComposition ?? this.endingComposition, phase: this.activeComposition !== null ? 'intermediate' as const : 'committed' as const }
        : { id: null, phase: 'none' as const }
      const changes: Change[] = []
      transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        changes.push({ fromA, toA, fromB, toB, inserted: inserted.toString(), removed: transaction.startState.doc.sliceString(fromA, toA) })
      }, true)
      const record: RecordEntry = {
        transactionId: ++this.transactionId,
        before: transaction.startState.doc.toString(), after: transaction.state.doc.toString(),
        changes, origin, userEvent, composition,
      }
      if (composition.id !== null) {
        this.compositionFirst ??= record.transactionId
        this.compositionLast = record.transactionId
      }
      freeze(record)
      this.retain(record)
      records.push(record)
    }
    if (records.length) this.emit('transactions', { records, transactionId: this.transactionId, journal: this.journalStatus() })
  }

  compositionStart() {
    this.finishComposition()
    this.activeComposition = ++this.compositionId
    this.compositionFirst = this.compositionLast = null
    this.emit('composition', { id: this.activeComposition, phase: 'start', transactionId: this.transactionId })
  }

  compositionUpdate() {
    if (this.activeComposition === null) this.compositionStart()
    this.emit('composition', { id: this.activeComposition, phase: 'update', transactionId: this.transactionId })
  }

  compositionEnd() {
    if (this.activeComposition === null) return
    this.endingComposition = this.activeComposition
    this.activeComposition = null
    // CM may dispatch the final input just after the DOM compositionend event.
    // Keep its ID through this task and publish the commit boundary afterward.
    this.endTimer = setTimeout(() => this.finishComposition(), 0)
  }

  private finishComposition() {
    if (this.endTimer !== null) clearTimeout(this.endTimer)
    this.endTimer = null
    const id = this.endingComposition ?? this.activeComposition
    if (id !== null && !this.destroyed) {
      this.completedThroughCompositionId = id
      this.emit('composition', {
      id, phase: 'end', transactionId: this.transactionId,
      firstTransactionId: this.compositionFirst, lastTransactionId: this.compositionLast,
      text: this.view.state.doc.toString(),
      // Only records whose composition.id matches are committed by this marker.
      // The interval can include remote/undo/reject records; those stay separate.
      })
    }
    this.activeComposition = this.endingComposition = null
    this.compositionFirst = this.compositionLast = null
  }

  destroy() {
    if (this.destroyed) return
    if (this.endTimer !== null) clearTimeout(this.endTimer)
    this.destroyed = true
    this.emit('destroy', { transactionId: this.transactionId, composition: { id: this.activeComposition ?? this.endingComposition, phase: 'aborted' } })
    sessions.delete(this)
    this.clearJournal()
  }
}

/** Native read-only observer, bound to the same immutable container as realtime(). */
export function rtexBridge({ currentDoc }: { currentDoc: { readonly doc_id: string } }): Extension {
  const docId = currentDoc.doc_id
  if (typeof docId !== 'string' || !docId) return []
  install()
  return ViewPlugin.define(view => new NativeSession(view, docId), {
    eventHandlers: {
      compositionstart() { this.compositionStart(); return false },
      compositionupdate() { this.compositionUpdate(); return false },
      compositionend() { this.compositionEnd(); return false },
    },
  })
}
