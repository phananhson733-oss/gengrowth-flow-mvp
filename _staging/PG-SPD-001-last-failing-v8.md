# Striking Distance Keywords Are Often Closer Than GSC Shows

## What Are Striking Distance Keywords?

Striking distance keywords are **queries your pages rank for between positions 5 and 20**, close enough to page one that targeted on-page work can often move them there — but only if the position reading in Search Console reflects genuine rank data and not an impression-weighted average that masks where the real opportunity sits.

- These pages already earn impressions — Google is surfacing them for the right topic — so the relevance signal exists
- The "striking distance" band varies across SEO guides: some use positions 5–20, others define it as 11–20 or simply "page two"
- The average position column in Search Console is an impression-weighted mean across all queries, devices, and countries — so a page can look stuck at position 14 while its most important queries already rank at 6 or 7

Because the column blends many signals into one number, a page's reported position is not a reliable proxy for how close it is to page one on any specific query. Identifying genuinely reachable pages means going below the aggregate view and examining query-level data. This process fits within the broader [[<TBD-internal-link: pillar guide to diagnosing organic traffic with Search Console data>]], which maps the full workflow from raw export to prioritized sprint list.

## Why It Matters for Your Workflow

Picking the wrong pages to optimize is one of the most predictable ways a content sprint comes back with no movement. Striking distance keywords give you a shortlist of pages that already signal relevance — pages Google is surfacing for the right topic but not ranking high enough to earn clicks. That is a fundamentally different situation from a page that has never ranked, and it calls for a different type of fix.

The workflow cost of misreading this is concrete. In the agency rollouts we've audited, teams consistently filter Search Console by average position 11–20, hand the resulting list to writers for refreshes, and then wonder two months later why positions barely shifted. The position column they filtered on was averaging a misleading blend of queries, devices, and countries into one number. Optimization was aimed at that blended number rather than the specific queries where a position move was actually achievable.

For any team whose core job is to read their own GSC data and find what to change first, the striking distance filter is the right starting point — but only after correcting for the impression-weighting problem that makes the raw average unreliable.

## How Position-Band Filtering Works in Real Agency Workflows

Striking distance keywords enter the workflow at the prioritization stage, not the research stage. Three common setups show how the process plays out differently depending on whether segmentation is applied:

1. **Agency content sprint.** A team filters GSC by average position 11–20 and assigns page refreshes for the sprint. The risk: some pages average 14 because they rank 6 on mobile and 22 on desktop. Those are two different problems requiring different fixes, and both are invisible at the aggregate level. Deciding which segment to address first requires going below the page-level filter.
2. **In-house SaaS team.** An SEO manager runs a quick-wins report in a third-party tool built on GSC data. Without a device or country segmentation step built into the workflow, the output carries the same impression-weighting blind spot as the raw export — even though the report looks processed and prioritized.
3. **White-label fulfillment.** A fulfillment partner receives a keyword prioritization list built on average position alone, refreshes meta tags and headings, marks tasks complete, and reports back. Average position moves by 0.2 — within noise range. The issue was not execution quality; the list never identified which specific queries, on which device, represented the actual gap.

The step where striking distance keywords deliver consistent value is after segmentation: filter by query, device, and country before treating any position as a realistic target.

## Common Misreadings When Working From Average Position

Most position-band guides follow the same three steps — pull GSC data, filter by position band, refresh the page. Four blind spots repeat consistently across those guides:

1. **The impression-weighted average trap.** The "Position" column in GSC is a weighted mean across every query, country, and device that triggered your page. A page ranking 6 on a high-volume query and 24 on a cluster of low-volume queries can average to 12. Filtering on that 12 misreads a nearly-there page as genuinely stuck in the middle of the band.
2. **The band definition problem.** Common definitions are 5–20, 11–20, and "page two." No universal cutoff applies — the right band depends on your site's actual click-through rate curve by position, which varies by vertical, brand recognition, and SERP feature mix. The band you choose determines which pages make the list without any grounding in the data itself.
3. **Treating the list as confirmed wins, not candidates.** Pages in the band are starting points for diagnosis, not guaranteed quick wins. A page averaging position 14 on a commercial intent query with 400 impressions is a meaningfully different situation from one averaging 14 on a navigational query driven by a single country.
4. **Skipping query-level diagnosis.** Average position signals that something is happening — it does not identify what. Filtering the Queries tab by a specific URL and sorting by position shows whether the gap is a content depth issue, a title match problem, or a SERP feature that on-page work will not displace.

## Average Position Candidates at a Glance — Quick Reference

| Scenario | Baseline approach | GSC-first approach | How to tell which fits |
|---|---|---|---|
| Page averages position 11–18 across all queries | Refresh content and update the meta title around the primary keyword | Filter the page in the GSC Queries tab; segment by device and country to find which subset is actually close to page one | If query-level data shows several queries at positions 5–9, the page is genuinely close; if the lowest query sits at 16, it is not a quick win |
| Quick-wins tool surfaces 40 candidate pages | Assign all 40 for content refreshes in one sprint | Cross-check average positions against impression volume; low-impression pages at position 12 carry less certainty than high-impression pages at position 12 | Prioritize pages where the position band overlaps with queries above your site's median impressions per query |
| Rankings did not move after a content refresh | Report average position before and after the update | Show query-level positions before and after, segmented by the specific queries that were the actual targets | If query-level positions moved but the page average did not, impression-share shifts from other queries are masking the gain |
| New site with many pages in the 11–20 band | Optimize everything in the band | Focus only on pages with at least 100 impressions in the past 28 days — below that, position data is too noisy to act on reliably | Impression count is the gate; positions on low-impression pages are not stable enough to prioritize against |

## How to Evaluate GSC Position-Band Pages

Before treating any page as a quick win, work through these checks:

1. **Impression volume gate.** Confirm the page has at least 100 impressions in the trailing 28-day window for the queries you are targeting. Below that count, position readings fluctuate for statistical reasons unrelated to ranking quality, and no optimization can produce measurable signal.
2. **Query-level position scan.** In the GSC Queries tab, filter by URL and sort by position. If the queries you care about sit at positions 6–9 while unrelated queries drag the average to 14, that is a genuinely reachable page. If the best specific query is already at 15, the page likely needs more substantial work than a refresh will produce. Pay particular attention to queries above your site's median impression count — those are the ones where a position move will translate to clicks.
3. **Device and country split.** A page averaging position 12 on desktop but 7 on mobile presents a different optimization task than one stuck at 12 across both segments. Run the device filter before deciding which technical or content changes to prioritize.
4. **SERP feature check.** Positions 1–3 on a query with a featured snippet or People Also Ask block carry different click-through dynamics than positions on a clean SERP. Understand what fills the top of page one before estimating what a position move is worth in traffic terms.
5. **Content match audit.** Confirm the page structure and depth match the intent and format of what ranks at the top of the SERP. An average position of 11 on a query dominated by tool landing pages signals a content type mismatch — on-page optimization will not close that gap without a format change.

## How to Build Your Quick-Wins List Step by Step

Here is the sequence for converting a raw GSC export into an actionable refresh list built on reliable striking distance keywords:

1. **Export 28-day performance data from GSC.** Go to Search Results > Pages > Export. Use the most recent complete 28-day period to avoid partial-week noise at the edges of the date range.
2. **Filter by average position 5–20.** This produces the broadest candidate set. Narrowing to 11–20 gives fewer but higher-certainty candidates, depending on your site's CTR curve.
3. **Apply the impression threshold.** Remove any page with fewer than 100 impressions in the window. Positions below this count are statistically unreliable — small shifts in query mix can move the average by several positions without any underlying ranking change.
4. **Open the Queries tab for each candidate URL.** Filter by URL, sort by position, and identify the specific queries sitting at positions 6–14. These are the actual optimization targets, not the page as an aggregate unit.
5. **Segment by device and country.** For each target query, check whether the position gap holds consistently on desktop and mobile and whether one country is skewing the average. Address the dominant segment first.
6. **Classify the root cause.** Determine whether the gap comes from content depth, title or heading alignment, or competitive SERP dynamics. Only the first two respond reliably to on-page changes; the third requires a different approach entirely.
7. **Refresh, re-index, and track at the query level.** After updating, request re-indexing via GSC. Measure position changes at the specific query level — not the page's overall average, which can shift for reasons outside your control.

You can run this sequence against your own data using the [[<TBD-internal-link: traffic drop diagnosis tool at gengrowth.ai>]], which surfaces impression-volume-filtered position gaps automatically.

## Common Questions About GSC Average Position

**What position range counts as striking distance?**

The range varies by guide — 5–20, 11–20, and "page two" are all common definitions. In practice, impression volume matters more than the exact cutoff: a page at position 14 with 500 impressions is a stronger candidate than one at position 8 with 20 impressions. Use impression count as the primary filter, then position as the secondary.

**Why did refreshed pages not improve in average position?**

The most common cause is optimizing against the page-level average rather than the query-level positions. If the page average is 14 but your target queries already sit at 7 or 8, and low-volume or navigational queries drag the average down, a content refresh will not move those unrelated queries — and the overall average will look unchanged even if the queries you specifically targeted actually moved.

**Is Search Console average position reliable enough for building a priority list?**

For rough shortlisting, yes. For final prioritization, no. Average position in GSC is an impression-weighted mean across all queries, devices, and countries that triggered a given URL. It is a useful first pass, but any page that makes the shortlist should be confirmed at the query level before optimization work is assigned.

**How do you know when position data is too noisy to trust?**

Check the impression count for the specific query you are targeting. Fewer than 100 impressions in a 28-day window typically means the position reading is unstable — small shifts in which queries trigger impressions can move the average by several positions without any actual ranking change. Filter these cases out before treating the remaining pages as confirmed candidates.

## Related Reading

- [[<TBD-internal-link: guide to diagnosing organic traffic drops with Search Console>]] — covers the full GSC diagnostic workflow that position-band filtering feeds into, including how to separate ranking drops from click-rate changes
- [[<TBD-internal-link: overview of SEO sprint planning for agency teams>]] — maps how position-band analysis connects to client reporting and quick-wins prioritization across retainer-based engagements

## Take Action

[Run a Free SEO Quick Wins Check](https://gengrowth.ai/tools/seo-quick-wins) against your Search Console data. The check filters your position 5–20 pages by impression volume and device segment, so the list it returns reflects pages with enough signal to act on — not raw position averages that blend reliable and noisy readings into a single column. That filtered output is your sprint-ready starting point: specific queries, the device segment where the gap actually lives, and a root cause classification to guide what changes to make first.

## Sources

- Google Search Central documentation — the canonical reference for how GSC calculates average position as an impression-weighted mean across queries, devices, and countries for a given URL
- Based on patterns GenGrowth has observed across agency and white-label SEO rollouts; no third-party study is cited
