import { useState } from "preact/hooks";

/** toolchain smoke test: preact island + tailwind, delete once the real UI lands */
export default function Counter() {
  const [n, setN] = useState(0);
  return (
    <button
      class="rounded bg-slate-800 px-3 py-1 text-sm text-slate-100"
      onClick={() => setN(n + 1)}
    >
      clicked {n}
    </button>
  );
}
