/** Layout shell: header / palette | canvas | inspector / terminal drawer (§13). Filled in by the UI builders. */
export function App() {
  return (
    <div className="flex h-full flex-col bg-zinc-50 text-zinc-900">
      <header className="flex h-12 items-center border-b border-zinc-200 bg-white px-4 font-semibold">promptgraph</header>
      <main className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading…</main>
    </div>
  );
}
