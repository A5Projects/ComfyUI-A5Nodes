// Session-only snapshots: keep text across tab switches without retaining nodes or DOM.
export function createPromptHistorySession() {
  const snapshots = new Map();

  function keyFor(node) {
    const graph = node.graph;
    const root = graph?.rootGraph ?? graph;
    if (!graph?.id || !root?.id || node.id == null || node.id === -1
        || root.id === "00000000-0000-0000-0000-000000000000") {
      return null;
    }
    return JSON.stringify([root.id, graph.id, node.id]);
  }

  return {
    save(node, history) {
      const key = keyFor(node);
      if (key) {
        snapshots.set(key, { entries: [...history.entries], index: history.index });
      }
    },
    restore(node, history, currentValue) {
      const snapshot = snapshots.get(keyFor(node));
      if (!snapshot) return false;
      history.entries = [...snapshot.entries];
      const currentIndex = history.entries.indexOf(currentValue);
      history.index = currentIndex >= 0 ? currentIndex : snapshot.index;
      history.dirty = history.entries[history.index] !== currentValue;
      return true;
    },
  };
}
