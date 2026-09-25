import type { Ref } from "vue";

/**
 * Which section the reader is currently in.
 *
 * This is the thing that turns a list of 134 links into a table of contents:
 * without it the rail is a menu, with it the rail is the reader's position in a
 * document. It is the whole of the difference between the two, and it is why
 * DESIGN.md insists the category is a heading you scroll to rather than a page
 * you navigate to.
 *
 * Implementation notes that are not obvious:
 *
 * - It observes the **whole section element**, not its heading. A section of 96
 *   rows is 3,000 pixels tall, so its heading leaves the band at the top of the
 *   viewport long before the reader has left the section; the element spans the
 *   band the entire time. With a `rootMargin` that collapses the viewport to a
 *   strip just below the masthead, "intersecting" means "under the masthead",
 *   which is what a reader means by where they are.
 * - Several sections can be in that strip at once (any run of short sections),
 *   so the answer is the **first in document order**, which is what `keys`
 *   supplies, not whichever entry the observer reported last.
 * - `content-visibility: auto` does not hide a section from an
 *   `IntersectionObserver`. The element still has a box and still intersects;
 *   only its contents are skipped. That is the same property that keeps `Ctrl+F`
 *   working, seen from the other side.
 * - Re-attaching on every reorder is deliberate: sorting replaces the elements
 *   entirely, and a stale observer holds references to detached nodes and
 *   reports nothing.
 */
export function useScrollSpy(keys: Ref<string[]>, enabled: Ref<boolean>) {
  const current = ref<string | null>(null);

  if (import.meta.server) return { current, jump };

  let io: IntersectionObserver | null = null;
  const visible = new Set<string>();

  /*
   * While a jump is in flight the observer must not answer.
   *
   * `jump` sets `current` to the heading the reader asked for, then the smooth
   * scroll crosses every section between here and there and the observer
   * reports each one, so `pick` overwrites the answer, and the rail lands on
   * whichever section happened to be under the masthead when the animation
   * stopped. With the correction pass still to run that is usually the one
   * *above* the one that was clicked, which is exactly what it looked like.
   */
  let pinnedUntil = 0;

  function pick() {
    if (performance.now() < pinnedUntil) return;
    /*
     * Keep the last answer when nothing is in the strip. That happens for a
     * few frames during a fast scroll and at the very top and bottom of the
     * page, and blanking the rail there reads as a bug rather than as a fact.
     */
    for (const k of keys.value) {
      if (visible.has(k)) {
        current.value = k;
        return;
      }
    }
  }

  function attach() {
    io?.disconnect();
    io = null;
    visible.clear();
    if (!enabled.value) {
      current.value = null;
      return;
    }
    /*
     * The strip: from just under the sticky masthead down a fifth of the
     * viewport. Tall enough that a short section passing through is caught on
     * some frame, short enough that "where I am" is the top of the screen and
     * not the middle of it.
     *
     * `rootMargin` takes px and % only (no rem, no var()), so the masthead is
     * measured rather than assumed. It changes height between the wide layout
     * and the narrow one, where the column labels are dropped.
     */
    const mast = document
      .querySelector(".mast")
      ?.getBoundingClientRect().height;
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const k = (e.target as HTMLElement).dataset.spy;
          if (!k) continue;
          if (e.isIntersecting) visible.add(k);
          else visible.delete(k);
        }
        pick();
      },
      { rootMargin: `-${Math.round(mast ?? 120)}px 0px -80% 0px` },
    );
    for (const el of document.querySelectorAll<HTMLElement>("[data-spy]")) {
      io.observe(el);
    }
  }

  watch(keys, () => nextTick(attach), { flush: "post" });
  watch(enabled, () => nextTick(attach), { flush: "post" });
  onMounted(() => nextTick(attach));
  onBeforeUnmount(() => io?.disconnect());

  /**
   * Go to a heading.
   *
   * `scrollIntoView` rather than a fragment: the prerendered HTML is a skeleton
   * and the rows arrive from the JSON, so at the moment the browser would
   * honour a `#hash` the target does not exist yet. That is also the reason the
   * section lives in `?cat=` and not in the fragment; see `useListQuery`.
   *
   * The offset under the masthead comes from `scroll-margin-top` on the
   * section, so it is stated once, in CSS, next to the masthead that causes it.
   */
  function jump(slug: string, smooth = true) {
    const el = document.getElementById(`s-${slug}`);
    if (!el) return false;
    /*
     * Instant, not smooth, and the `smooth` argument is now only a hint about
     * how long to hold the rail still.
     *
     * A smooth scroll to the 43rd of 134 headings animates across tens of
     * thousands of pixels, and every section it crosses is laid out for the
     * first time *while it travels*, so the destination moves under the
     * animation and `scrollBy` corrections issued mid-flight are swallowed by
     * it. The observed result was landing six rows into the section instead of
     * at its heading. An instant jump is computed against the layout as it
     * stands and then corrected once it settles, which is the only order of
     * operations that converges.
     */
    el.scrollIntoView({ block: "start", behavior: "auto" });
    current.value = slug;
    /* hold the rail through the correction passes */
    pinnedUntil = performance.now() + (smooth ? 400 : 150);
    correct(el, 4);
    return true;
  }

  /**
   * Land the heading where it was asked to land.
   *
   * `content-visibility: auto` is why this is needed. Scrolling to a section
   * 20,000 pixels down crosses sixty sections the browser has never laid out,
   * so the distance it scrolls is computed from `contain-intrinsic-size`
   * *estimates*; as those sections come into range and are measured for real,
   * everything below them moves. Measured on `selfhosted`, a jump to the 43rd
   * heading overshot its mark by 115 px, enough that the heading sat a row and
   * a half below where the reader was promised it.
   *
   * So the scroll is corrected against the element's own `scroll-margin-top`
   * once the frame has settled, twice at most. The alternative (dropping
   * `content-visibility` so the arithmetic is exact) costs the ~600 ms of
   * layout the whole approach exists to avoid.
   */
  function correct(el: HTMLElement, tries: number) {
    if (tries <= 0) return;
    requestAnimationFrame(() => {
      const want = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      const off = el.getBoundingClientRect().top - want;
      if (Math.abs(off) < 4) return;
      window.scrollBy({ top: off, behavior: "auto" });
      correct(el, tries - 1);
    });
  }

  return { current, jump };
}
