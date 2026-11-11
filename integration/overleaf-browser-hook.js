/* Experimental Overleaf CodeMirror 6 adapter. No source writes, credentials or auto-enable.
 * Install in the page bundle; the host must supply an authoritative document-id mapping.
 * This unsupported Overleaf extension API must be verified against the deployed version.
 */
export function minimalChange(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  if (start > 0 && /[\uD800-\uDBFF]/.test(before[start-1])) start--;
  let end = before.length, nextEnd = after.length;
  while (end > start && nextEnd > start && before[end-1] === after[nextEnd-1]) { end--; nextEnd--; }
  if (end < before.length && end > start && /[\uD800-\uDBFF]/.test(before[end-1])) {end++; nextEnd++;}
  return {start, end, text:after.slice(start,nextEnd)};
}

export function installRealtimeTex({baseURL, token, projectId, documentId, documentPath = 'main.tex', getActiveDocument, getDocumentForState, onStatus = () => {}}) {
  const base = new URL(baseURL);
  if (base.protocol !== 'https:' && base.hostname !== '127.0.0.1') throw Error('Use HTTPS or a loopback bridge');
  if (!token || !projectId || !documentId || typeof getActiveDocument !== 'function' || typeof getDocumentForState !== 'function') throw Error('Explicit project/document binding required');
  let stopped = false, conflicted = false, revision, shadow, desired, timer, chain = Promise.resolve();
  const abort = new AbortController();
  async function api(path, body) {
    const response = await fetch(new URL(path.replace(/^\//,''), new URL(base.href.endsWith('/') ? base.href : base.href+'/')), {method: body ? 'POST' : 'GET', headers: {
      ...(token === 'session' && typeof location !== 'undefined' && base.origin === location.origin ? {} : {Authorization: `Bearer ${token}`}), ...(body ? {'Content-Type': 'application/json'} : {})
    }, body: body ? JSON.stringify(body) : undefined, signal: abort.signal, credentials: typeof location !== 'undefined' && base.origin === location.origin ? 'same-origin' : 'omit'});
    if (!response.ok) throw Error(`Realtime bridge ${response.status}: ${await response.text()}`);
    return response.json();
  }
  function bound() {
    const active = getActiveDocument();
    return active?.projectId === projectId && active?.documentId === documentId && active?.path === documentPath;
  }
  function accept(snapshot, editorState) {
    const identity = getDocumentForState(editorState);
    if (!identity || identity.projectId !== projectId || identity.documentId !== documentId || identity.path !== documentPath) return;
    if (stopped || conflicted || !bound()) return;
    desired = snapshot;
    clearTimeout(timer);
    timer = setTimeout(() => { chain = chain.then(flush).catch(fail); }, 35);
  }
  function fail(error) {
    if (stopped) return;
    conflicted = true;
    onStatus({state:'stopped', message: String(error)});
  }
  async function flush() {
    if (stopped || conflicted || !bound() || desired === undefined) return;
    const text = desired;
    if (revision === undefined) {
      const current = await api('/api/document?'+new URLSearchParams({path:documentPath,projectId,docId:documentId}));
      if (!bound() || stopped) return;
      if (!current.engineAlive) throw Error('Realtime engine is unavailable');
      if (current.text !== text) throw Error('Project snapshot mismatch. Refresh the test project copy before binding; no automatic overwrite was performed.');
      revision = current.revision;
      shadow = text;
      onStatus({state:'connected', revision});
    } else if (text !== shadow) {
      // Send the minimal changed UTF-16 range to preserve the engine fast path.
      // Single writer prototype: revision conflict stops; it never blindly retries.
      const result = await api('/api/edit', {revision, path:documentPath, projectId, docId:documentId, ...minimalChange(shadow,text)});
      shadow = text;
      revision = result.revision;
      onStatus({state:'updated', revision});
    }
    if (desired !== text && !stopped) chain = chain.then(flush).catch(fail);
  }
  const listener = event => {
    if (stopped) return;
    const {CodeMirror, extensions} = event.detail;
    // Plugin creation obtains a complete editor state, not a virtualized DOM excerpt.
    extensions.push(CodeMirror.ViewPlugin.define(view => {
      const initialState = view.state;
      queueMicrotask(() => accept(initialState.doc.toString(), initialState));
      return {update(update) { if (update.docChanged) accept(update.state.doc.toString(), update.state); }};
    }));
  };
  window.addEventListener('UNSTABLE_editor:extensions', listener);
  window.dispatchEvent(new Event('editor:extension-loaded'));
  return { stop() {
    stopped = true; clearTimeout(timer); abort.abort(); token = '';
    window.removeEventListener('UNSTABLE_editor:extensions', listener);
    window.dispatchEvent(new Event('editor:extension-loaded'));
    onStatus({state:'disabled'});
  }};
}
