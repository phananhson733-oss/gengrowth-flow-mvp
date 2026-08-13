# How Striking Distance Keywords Reveal the Right Pages to Fix First

## What Is a Striking Distance Keyword?

Striking distance keywords are **queries where your pages already rank in the 5–20 position range** — a default starting point that varies by site and competitive landscape, but one that reflects a core idea: you are already in range, and closing the gap is faster than starting from scratch.

- These queries appear in GSC with average positions in the 5–20 band, often with solid impression counts but low click-through rates
- Ranking inside the top five generates significantly more clicks than ranking on page two, because click-through rates fall sharply as position numbers climb
- Unlike entirely new keyword targets, pages in this range have already passed Google's basic indexing threshold; the work is about signaling relevance more precisely

This article is part of [[<TBD-internal-link: pillar guide to reading Search Console data for SEO diagnosis>]], which maps the full diagnostic workflow from identifying a traffic drop to deciding what to change first.

## Why It Matters for Your Workflow

When a team decides what to work on next, the instinct is often to publish new content or build more links. Striking distance keywords point to a faster alternative: pages that already exist, already rank, and already attract impressions — but leak clicks because they sit just outside the positions where users consistently click through.

The practical value is prioritization. For agencies on monthly retainers, data-backed prioritization separates a defensible content plan from a list of tasks. For in-house teams, it shortens the distance between "we need more traffic" and "here is exactly what to fix this week."

For a structured starting point, [[<TBD-internal-link: traffic drop diagnosis tool and workflow>]] walks through how to segment GSC data as a first diagnostic step before drawing any conclusions about which pages to fix.

## How Striking Distance Keywords Work in Real Agency Scenarios

The standard advice is simple: export GSC, filter for average position between 11 and 20, and refresh those pages. In practice, the workflow has several more steps — and a statistical trap worth naming before you hit it.

1. **Export GSC performance data** for a rolling 90-day window grouped by query. Set an impressions floor of 200 — queries below that threshold typically won't generate more than 15 monthly visits even at a top-five click-through rate, so they won't move the business regardless of position.
2. **Apply your position filter** using a consistent band. Position 5–20 is the most common starting point. Note that this filter operates on GSC's impression-weighted average position, not a simple median or mode. Two queries both showing "average position 15" can have very different distributions: one might show your page 1,000 times consistently at position 15; the other might show it 250 times at position 3 and 750 times at position 19 — producing an identical aggregate of 15 but requiring a different optimization response.
3. **Segment by country and device** before trusting any row in the export. A query showing average position 14 in aggregate might already rank position 4 in your primary market and position 24 everywhere else. The aggregate obscures that difference entirely.
4. **Group remaining queries by landing page URL** to find which pages have the highest concentration of striking distance keywords. A single page with eight qualifying queries is a better candidate than eight pages each with one.
5. **Prioritize by impressions and click-through gap.** A query at position 6 with high impressions and a below-average CTR has more upside than one at position 18 with minimal traffic potential.

## Common Implementation Misreadings

Teams running this analysis often make the same four mistakes:

1. **Treating average position as a simple average.** A query returning your page 900 times at position 4 and 100 times at position 22 reports an aggregate near position 6 — not position 4. A pattern observed repeatedly in audits: teams re-optimize a page and see no movement because the page was already ranking well in the primary market; off-target impressions from secondary geographies had inflated the aggregate number.
2. **Using inconsistent position bands across reporting periods.** Published guides use ranges from 5–20, 8–20, and 11–20 — none is universally wrong, but switching between them makes period-over-period comparison meaningless. Pick one band and hold it for at least a quarter before reconsidering.
3. **Skipping country and device segmentation.** Filtering by position without geographic breakdowns produces a list that mixes pages already performing well in your core market with pages that are genuinely stuck — with no way to tell them apart.
4. **Optimizing for the aggregate query instead of specific query variants.** If a page qualifies on 10 different queries, the right fix is often different for each. Refreshing the title for the highest-volume query and ignoring the others leaves clear wins untouched.

## Striking Distance Keywords at a Glance — Quick Reference

| Scenario | Tempting (Wrong) Move | What Segmentation Reveals | How to Diagnose |
|---|---|---|---|
| Page shows average position 11–20, single primary market | Refresh copy and expect position gains | Whether the page genuinely ranks mid-page or already ranks top 5 for your core geography | Compare country-filtered data to the aggregate position |
| Page shows position 14 in aggregate, serves multiple geographies | Commission new supporting content | The page may already rank well in the primary market while off-target impressions drag the aggregate down | Country breakdown: if aggregate and in-market positions differ by more than five positions, use in-market data as the signal |
| Multiple queries landing on one URL, all in range | Optimize for the single highest-volume query | Which sub-topics are genuinely stuck versus already ranking well | Match each query to the section it targets; fix only stuck sub-topics |
| Page ranking 6–10 with high impressions but low CTR | Assume ranking is healthy and deprioritize | The gap is in the title or meta description, not content depth | Check CTR against vertical benchmarks at that position |

## How to Evaluate Striking Distance Keywords

Not every query in the 5–20 band is worth acting on. Five criteria separate high-signal candidates from noise:

1. **Impressions above 200 in the 90-day window.** Queries below this threshold won't generate meaningful traffic even at a top-five click-through rate.
2. **Click-through rate below the position benchmark.** A page ranking at position 7 with 2% CTR when comparable pages pull 5–6% points to a title or meta description problem — a faster fix than a content overhaul.
3. **Stable ranking with low variance over the period.** A query bouncing between position 8 and 26 signals a different problem than one sitting consistently at position 14. Stable mid-range rankings usually have a mechanical fix available: a title tag update or a new internal link from a higher-authority page.
4. **Alignment between query intent and landing page format.** If the query reads as a comparison search and the page is structured as a definition post, the ranking ceiling is set by content format — not on-page signals you can tune in isolation.
5. **No active cannibalization conflict.** If two pages on the same site both appear in the 5–20 range for the same query, resolve that overlap first. Check for [[<TBD-internal-link: guide to identifying and resolving keyword cannibalization in Search Console>]] patterns before writing any new copy.

## How to Implement Striking Distance Keywords Step by Step

The steps below work directly from GSC — no third-party tool required.

1. **Export 90-day query data** from GSC Performance grouped by query. Use the date-comparison feature to pull the equivalent prior period so you can track position changes, not just static snapshots.
2. **Apply your position filter** for your chosen band (5–20 is the most common starting point) and set an impressions floor of 200 for the period. Export to CSV.
3. **Run a second export filtered to your primary market country.** Merge both to find queries where aggregate and in-market positions differ by more than five positions — those are your priority segmentation candidates.
4. **Group by landing page URL.** Pages carrying three or more qualifying striking distance queries deserve attention before any page with a single qualifying query.
5. **Diagnose the likely fix for each high-priority page.** Common fix types include: title tag alignment, H1 or header restructuring, internal links pointing to the page, or added depth on the specific sub-topic the query is targeting.
6. **Make one change at a time and record the date.** GSC has a 48-hour data lag, and position changes can take two to four weeks to stabilize — batching multiple edits on the same day makes it impossible to attribute what moved.
7. **Re-export and compare after 30 days.** Track position and CTR independently — a title-tag fix often improves CTR before it changes position, which is a useful diagnostic signal in itself.

For teams that want to turn this into a repeatable client deliverable, [[<TBD-internal-link: overview of the SEO quick wins analysis for agency reporting>]] covers how to format the output for a monthly retainer review.

## Common Questions About Striking Distance Keywords

**What position range counts as "striking distance"?**

No universal standard exists — published guides use ranges from 5–20, 8–20, and 11–20, and some use "page two" as the criterion. The specific range matters less than applying a consistent one across reporting periods. Pick a band that reflects your site's competitive situation and hold it for at least a quarter before revisiting.

**Why do my GSC positions look different from what Ahrefs or Semrush reports?**

GSC reports impression-weighted average positions across all queries, countries, and devices that triggered your page during the period. Third-party tools sample from specific geographies and query sets. For this type of analysis, GSC is the authoritative source — it reflects your actual traffic patterns, not an estimated proxy.

**Can a page have too many qualifying queries to be worth optimizing?**

A page with 15 qualifying queries spread across very different intents may need structural changes — splitting into separate pages or adding targeted sections — rather than a single content refresh. The value of this workflow is focusing effort on pages with concentrated upside, not maximum raw impression count.

**How often should this analysis run?**

Monthly is standard for active content programs; quarterly works for lower-traffic sites. Consistency matters more than frequency — applying the same filter to the same date-range structure each time keeps period-over-period comparisons meaningful.

## Related Reading

- [[<TBD-internal-link: guide to segmenting Search Console data by country and device>]] — segmentation steps that prevent misleading candidate lists
- [[<TBD-internal-link: overview of content refresh prioritization for existing pages>]] — deciding which pages to act on once candidates are identified
- [[<TBD-internal-link: guide to diagnosing keyword cannibalization in Search Console>]] — relevant when multiple pages on the same domain appear in the same query band

## Take Action

[Run a Free SEO Quick Wins Check](https://gengrowth.ai/tools/seo-quick-wins) to get a pre-segmented view of your GSC data with striking distance keyword candidates already filtered and sorted by upside. The tool outputs a prioritized page list with the likely fix type flagged for each entry — title alignment, internal links, or content depth. That output tells you within minutes which pages are worth touching first and which lever to pull, instead of spending an afternoon in spreadsheets to reach the same decision.

## Sources

- Google Search Central documentation — the authoritative reference for how GSC calculates average position as an impression-weighted metric across all queries, countries, and devices in a reporting period
- Based on patterns GenGrowth has observed across agency and in-house SEO audits; no third-party study is cited