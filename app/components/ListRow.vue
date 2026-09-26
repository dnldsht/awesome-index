<script setup lang="ts">
import { ROW, type Row } from "~~/src/lib/contracts";
import { PERIOD_FIELD, type Period } from "~/utils/order";

/*
 * One entry of one list, in 32 pixels.
 *
 * The whole visual direction in DESIGN.md exists to make this component
 * possible: no card, no border, no shadow, one hairline underneath, and seven
 * columns that line up down the page because a monospace sets every figure.
 * Twenty-five of these fit on a screen. A card layout fits eight, on a list of
 * 2,829.
 *
 * Three things here are rules rather than choices, and each has a reason
 * recorded in DESIGN.md:
 *
 * 1. `Row[ROW.TREND]` is never rendered. It is the acceleration score, it has
 *    no unit a reader could interpret, and it exists to sort. What the row
 *    shows is `d7`/`d30`/`d365`, counts of actual stars. An ordering is a
 *    decision; a printed number is a claim. Sorting by `trending` therefore
 *    changes the *order* of these rows and nothing that appears on any of them.
 * 2. Null is not zero. A repository we have not measured and a repository that
 *    gained nothing are different statements and get different marks.
 * 3. A `web` row is not a degraded `github` row. It has no stars, no language,
 *    no licence and no pulse, and it never will: 260 of golang's 2,829 rows
 *    and 88% of the corpus's non-GitHub targets are permanently in this state.
 *    Its numeric columns stay empty and its host takes the tag column, because
 *    where a link points is the one durable fact we hold about it.
 */

const props = defineProps<{
  row: Row;
  open: boolean;
  /* which of the three windows the delta column is showing; follows `?period=`
   * and therefore only ever moves off 30d under the trending order */
  period: Period;
}>();
defineEmits<{ toggle: [] }>();

const r = computed(() => props.row);
const isRepo = computed(() => r.value[ROW.KIND] === "github");

const ownerPrefix = computed(() =>
  owner(r.value[ROW.ID], r.value[ROW.KIND] as "github" | "web"),
);

/*
 * The delta column follows the window. It is 30 days everywhere except under
 * the trending order, where the reader has said which window they mean and it
 * would be incoherent to rank by one and print another.
 */
const d = computed(() => r.value[PERIOD_FIELD[props.period]] as number | null);

const isArchived = computed(() => r.value[ROW.ARCHIVED] === 1);

/*
 * The activity cell is the age since the last push (the fact), and the state
 * label, when we have one, is carried as a weight on it plus a title. Archived
 * is the exception and is marked with a dagger, because it is the one state
 * the author declared rather than one we inferred, and it belongs in a
 * different category from our three guesses. The expanded row spells both out
 * with the unrounded date beside them.
 */
const activityTitle = computed(() => {
  const at = isoDate(r.value[ROW.LAST_ACTIVITY]);
  if (isArchived.value) return at ? `archived · last push ${at}` : "archived";
  const state = r.value[ROW.STATE];
  return [state, at].filter(Boolean).join(" · ");
});

/* ---- the star curve ---------------------------------------------------- */

/*
 * The full history, from star-history.com's SVG (MIT, CORS-open, 24-hour edge
 * cache), and the three rules around it are not negotiable:
 *
 * - **On demand only.** The `<img>` exists only while the row is open, which is
 *   what makes the request happen on the click and not before. It is 64 KB
 *   against somebody else's service; 2,829 of them on one page load would be
 *   indefensible, and it is the reason DESIGN.md rules out an inline sparkline
 *   on the row.
 * - **Never for a `web` row.** There is no repository to ask about.
 * - **It is allowed to fail.** It 500s on some repositories. A broken image
 *   icon in the middle of an expanded row would read as the page being broken,
 *   so the failure is caught and stated in one line, with the link out still
 *   offered: the reader can go and look, which is all the image was doing.
 *
 * The 14 months of history the site holds never appear here. They exist only at
 * build time, to compute the four integers the row carries; this curve goes
 * back to 2012 and we store none of it.
 */
const { dark } = useTheme();

const chart = computed(
  () =>
    `https://api.star-history.com/svg?repos=${encodeURIComponent(
      r.value[ROW.ID],
    )}&type=Date${dark.value ? "&theme=dark" : ""}`,
);

const failed = ref(false);
/* the component is reused across rows as the list reorders, and a failure
 * belongs to the repository, not to the slot it was rendered in */
watch(
  () => r.value[ROW.ID],
  () => (failed.value = false),
);

/* ---- health, on demand -------------------------------------------------- */

/*
 * What the past twelve months looked like from the outside, from ecosyste.ms:
 * `commits.` for who writes the code, `issues.` for who answers. Both are
 * free, need no key, are CORS-open and come back under 5 KB gzipped, which is
 * what makes the reader's browser the right place to ask from: the 5,000/hour
 * rate limit is theirs, one repository at a time, rather than ours and 40,659
 * of them. Nothing caches it but the browser, which is enough — the responses
 * are public for a day.
 *
 * Same three rules as the curve below: only while the row is open, only for a
 * repository, and allowed to fail in silence. The two calls fail
 * independently, because a repository indexed for one and not the other is
 * common and half a section still says something.
 *
 * Bots are subtracted from every count here, and that is most of the point.
 * `pushed_at`, which the band shows, cannot tell a dependabot run from six
 * people working — DESIGN.md records it as the weakest link in the activity
 * design — and in this corpus `terraform-linters/tflint` is 197 commits of
 * which 141 are a bot.
 *
 * What it costs to fetch it here rather than store it: none of these numbers
 * can sort, filter or label anything, because the build never sees them. That
 * is the crawl-side job DESIGN.md already earmarks against `pushed_at`.
 */
type CommitsJson = {
  past_year_total_commits?: number;
  past_year_total_bot_commits?: number;
  past_year_total_committers?: number;
  past_year_dds?: number;
};

type IssuesJson = {
  past_year_issues_count?: number;
  past_year_bot_issues_count?: number;
  past_year_avg_time_to_close_issue?: number | null;
  past_year_pull_requests_count?: number;
  past_year_bot_pull_requests_count?: number;
  past_year_pull_request_authors?: Record<string, number>;
  active_maintainers?: unknown[];
};

const commits = ref<CommitsJson | null>(null);
const issues = ref<IssuesJson | null>(null);

async function ask<T>(host: string, id: string): Promise<T | null> {
  try {
    const res = await fetch(
      `https://${host}.ecosyste.ms/api/v1/hosts/GitHub/repositories/${encodeURIComponent(id)}`,
    );
    /* 202 is "indexing it now, ask again later" and 404 "never seen it"; to a
     * reader the two are the same thing, which is nothing */
    return res.status === 200 ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

watchEffect(() => {
  commits.value = null;
  issues.value = null;
  if (!props.open || !isRepo.value) return;
  const id = r.value[ROW.ID];
  /* the component is reused as the list reorders, so a late answer belongs to
   * the repository it was asked about, not to the slot it comes back to */
  const mine = () => r.value[ROW.ID] === id;
  void ask<CommitsJson>("commits", id).then((d) => {
    if (mine()) commits.value = d;
  });
  void ask<IssuesJson>("issues", id).then((d) => {
    if (mine()) issues.value = d;
  });
});

/** commits by people, bots removed; null when nobody committed at all, which
 *  is a different statement from "we could not ask" but reads the same here */
const humanCommits = computed(() => {
  const d = commits.value;
  if (!d) return null;
  const n =
    (d.past_year_total_commits ?? 0) - (d.past_year_total_bot_commits ?? 0);
  return n > 0 ? n : null;
});

/** the busiest committer's share of the year, from `dds`, which ecosyste.ms
 *  reports as the share that is *not* theirs */
const topShare = computed(() =>
  commits.value?.past_year_dds == null ? null : 1 - commits.value.past_year_dds,
);

const humanIssues = computed(() => {
  const d = issues.value;
  if (!d) return null;
  const n =
    (d.past_year_issues_count ?? 0) - (d.past_year_bot_issues_count ?? 0);
  return n > 0 ? n : null;
});

const humanPrs = computed(() => {
  const d = issues.value;
  if (!d) return null;
  const n =
    (d.past_year_pull_requests_count ?? 0) -
    (d.past_year_bot_pull_requests_count ?? 0);
  return n > 0 ? n : null;
});

/*
 * How many *people* opened them. `past_year_pull_request_authors` is a
 * complete login → count map (checked against `..._authors_count` on
 * repositories with 4, 5, 170 and 320 authors), so the bots can be named and
 * dropped rather than estimated.
 *
 * The count of merged pull requests is deliberately not shown beside this:
 * ecosyste.ms counts merges with the bot's included, so `Tochemey/goakt` reads
 * "61 pull requests, 80 merged" — two true numbers that cannot share a line.
 */
const humanPrAuthors = computed(() => {
  const a = issues.value?.past_year_pull_request_authors;
  if (!a) return null;
  const n = Object.keys(a).filter((login) => !login.endsWith("[bot]")).length;
  return n > 0 ? n : null;
});

/** average days to close an issue; null when the year closed none, which is
 *  itself worth not printing rather than printing as zero */
const closeDays = computed(() => {
  const s = issues.value?.past_year_avg_time_to_close_issue;
  return s ? Math.round(s / 86400) : null;
});
</script>

<template>
  <div class="row" :class="{ 'is-open': open }" @click="$emit('toggle')">
    <a
      class="nm"
      :href="r[ROW.URL]"
      rel="noopener nofollow"
      target="_blank"
      @click.stop
      ><span v-if="ownerPrefix" class="ow">{{ ownerPrefix }}</span
      ><span v-else-if="!isRepo" class="ow host">{{ host(r[ROW.URL]) }}</span
      >{{ r[ROW.TITLE] }}</a
    >

    <span class="nt">{{ r[ROW.NOTE] }}</span>

    <!-- stars: a number, a dim dash for "not measured", nothing for a link -->
    <span class="st" :class="{ nil: isRepo && r[ROW.STARS] == null }">{{
      !isRepo ? "" : r[ROW.STARS] == null ? "–" : stars(r[ROW.STARS]!)
    }}</span>

    <span
      class="dl"
      :class="{
        nil: isRepo && d == null,
        up: d != null && d > 0,
        down: d != null && d < 0,
      }"
      :title="
        isRepo && d != null ? `${delta(d)} stars over ${period}` : undefined
      "
      >{{ !isRepo ? "" : d == null ? "–" : delta(d) }}</span
    >

    <span
      class="ac"
      :class="isArchived ? 'archived' : r[ROW.STATE]"
      :title="activityTitle || undefined"
      >{{ isArchived ? "† " : "" }}{{ age(r[ROW.LAST_ACTIVITY]) }}</span
    >
  </div>

  <!--
    Expansion. Everything the 32px band had to drop: the note in full, the
    licence and language spelled out, the unrounded date, all three windows,
    the URL and, for a repository, the whole star curve.
  -->
  <div v-if="open" class="open">
    <!--
      Only when the band clipped it. Roughly 90 characters fit in the note
      column at a usual width, and repeating a note the reader can already see
      one line above is noise. The panel exists for what the 32px band could
      not hold, not for a second copy of what it could.
    -->
    <p v-if="(r[ROW.NOTE]?.length ?? 0) > 90" class="open-note">
      {{ r[ROW.NOTE] }}
    </p>
    <div class="open-grid">
      <span v-if="r[ROW.LANGUAGE]"
        >language <b>{{ r[ROW.LANGUAGE] }}</b></span
      >
      <span v-if="r[ROW.LICENSE]"
        >licence <b>{{ r[ROW.LICENSE] }}</b></span
      >
      <span v-if="r[ROW.LAST_ACTIVITY]"
        >{{
          isArchived ? "archived, last push" : (r[ROW.STATE] ?? "last push")
        }}
        <b>{{ isoDate(r[ROW.LAST_ACTIVITY]) }}</b></span
      >
      <span v-if="!isRepo"
        >link <b>{{ host(r[ROW.URL]) }}</b> · no stars, no pulse, and never will
        have</span
      >
      <span
        >curator’s position <b>#{{ r[ROW.POSITION] + 1 }}</b></span
      >
    </div>
    <a
      class="open-url"
      :href="r[ROW.URL]"
      rel="noopener nofollow"
      target="_blank"
      >{{ r[ROW.URL] }}</a
    >

    <!--
      Health: four counts about the past year that the band cannot hold and
      the dataset does not have. Each is printed only when it says something —
      a repository with no closed issues gets the count without the average,
      and the busiest committer's share appears only above half and only with
      more than one committer, since below that the people count said it
      already. The credit is not decoration: the numbers are somebody else's
      measurement, given away for free, and saying so is the price.
    -->
    <template v-if="commits || issues">
      <hr class="open-sep" />
      <div class="open-grid sect">
        <span class="sect-h">past 12 months</span>
        <span v-if="humanCommits != null"
          ><b>{{ count(humanCommits, "commit") }}</b> from
          <b>{{
            count(commits?.past_year_total_committers ?? 0, "person", "people")
          }}</b
          ><template
            v-if="
              (commits?.past_year_total_committers ?? 0) > 1 &&
              topShare != null &&
              topShare >= 0.5
            "
            >, <b>{{ Math.round(topShare * 100) }}%</b> of them by one</template
          ></span
        >
        <span v-if="issues?.active_maintainers?.length"
          ><b>{{
            count(issues.active_maintainers.length, "active maintainer")
          }}</b></span
        >
        <span v-if="humanIssues != null"
          ><b>{{ count(humanIssues, "issue") }}</b
          ><template v-if="closeDays != null">
            · closed in <b>{{ count(closeDays, "day") }}</b> on
            average</template
          ></span
        >
        <span v-if="humanPrs != null"
          ><b>{{ count(humanPrs, "pull request") }}</b
          ><template v-if="humanPrAuthors != null">
            from
            <b>{{ count(humanPrAuthors, "person", "people") }}</b></template
          ></span
        >
        <span class="health-src"
          >via
          <a
            href="https://ecosyste.ms"
            rel="noopener"
            target="_blank"
            @click.stop
            >ecosyste.ms</a
          ></span
        >
      </div>
    </template>

    <!--
      Stars: our four integers immediately above the curve they were derived
      from, so a reader checking "+101 this year" against the shape of the line
      does not have to hold the number in their head while scrolling past the
      rest of the panel.
    -->
    <template v-if="isRepo">
      <hr class="open-sep" />
      <div class="open-grid sect">
        <span class="sect-h">stars</span>
        <span
          ><b>{{
            r[ROW.STARS] == null ? "not measured" : stars(r[ROW.STARS]!)
          }}</b></span
        >
        <span
          >7d <b>{{ r[ROW.D7] == null ? "-" : delta(r[ROW.D7]!) }}</b> · 30d
          <b>{{ r[ROW.D30] == null ? "-" : delta(r[ROW.D30]!) }}</b> · 1y
          <b>{{ r[ROW.D365] == null ? "-" : delta(r[ROW.D365]!) }}</b></span
        >
      </div>
      <figure class="chart">
        <img
          v-if="!failed"
          class="chart-img"
          :src="chart"
          :alt="`star history of ${r[ROW.ID]}`"
          width="800"
          height="533"
          decoding="async"
          @error="failed = true"
        />
        <!-- a caption only for the failure: the chart carries its own
             star-history.com mark, and a line repeating it was noise -->
        <figcaption v-if="failed" class="chart-cap">
          no star history for this repository;
          <a
            :href="`https://star-history.com/#${r[ROW.ID]}&Date`"
            rel="noopener nofollow"
            target="_blank"
            >try star-history.com</a
          >
        </figcaption>
      </figure>
    </template>
  </div>
</template>
