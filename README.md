# gsc-coverage-mcp

A Google Search Console MCP server for Claude (or any MCP client) that pulls every row Google will give you and tells the model how much of the picture those rows cover.

## Why

The Search Analytics API returns 1,000 rows by default and at most 25,000 per request. Many GSC connectors make one request and stop. The model does correct math on that first slice and writes a report that reads as if it covered the whole site.

Even a full pull isn't every query. Google drops anonymized and rare queries, so query-level rows never add up to the property totals. On a small site it is normal for query rows to cover only half of all clicks.

That's how an audit goes wrong while every number in it checks out: "dead" pages that actually have impressions, cannibalization that was missed, content gaps for pages you already have, and "lost rankings" that are just two pulls with different coverage. 

This server fixes the two parts a connector can fix:

1. **Pagination.** `search_analytics` walks `startRow` in 25,000-row pages until Google runs out of rows, up to a `maxRows` safety cap you control.
2. **A coverage report on every pull.** Each response includes a `coverage` block, so the model has to see what it is working from before it writes recommendations.

## What a response looks like

```json
{
  "coverage": {
    "window": { "startDate": "2026-09-01", "endDate": "2026-09-30", "type": "web", "dataState": "final" },
    "dimensions": ["query"],
    "rowsReturned": 3412,
    "pagesFetched": 1,
    "apiExhausted": true,
    "truncated": false,
    "propertyTotals": { "clicks": 1980, "impressions": 412300 },
    "rowSums": { "clicks": 1104, "impressions": 301877 },
    "clickCoveragePct": 55.8,
    "impressionCoveragePct": 73.2,
    "notes": [
      "Query rows never add up to property totals: Google drops anonymized and rare queries. The gap comes from Google's privacy filtering, and the missing clicks still belong to pages you have.",
      "Missing from these rows is not the same as zero. Check any absent URL or query with a direct filter before calling it lost or invisible."
    ]
  },
  "file": "/tmp/gsc-coverage-mcp/pull-1761650000000.csv",
  "preview": [{ "query": "example query", "clicks": 84, "impressions": 2210, "ctr": 3.8, "position": 4.12 }]
}
```

(Illustrative numbers.)

Large pulls are written to CSV or JSON, and only a preview comes back inline. That keeps 80,000 rows out of the model's context window while still giving it the full file to work with.

## Tools

| Tool | What it does |
| --- | --- |
| `list_sites` | Lists the properties your credentials can read. |
| `search_analytics` | Paginated performance pull with a coverage report. |

`search_analytics` inputs:

| Input | Default | Notes |
| --- | --- | --- |
| `siteUrl` | required | Exactly as GSC lists it: `sc-domain:example.com` or `https://www.example.com/` |
| `startDate`, `endDate` | required | `YYYY-MM-DD` |
| `dimensions` | `["query"]` | Any of `query`, `page`, `country`, `device`, `date`, `searchAppearance`, `hour` |
| `type` | `web` | `web`, `image`, `video`, `news`, `discover`, `googleNews` |
| `dataState` | `final` | `all` includes fresh, not-yet-final data |
| `aggregationType` | API default | `auto`, `byPage`, `byProperty`, `byNewsShowcasePanel` |
| `filters` | none | ANDed `{ dimension, operator, expression }` filters, applied to both the rows and the totals |
| `maxRows` | `100000` | Safety cap across all pages. If it is hit, `truncated` is `true` |
| `includeCoverage` | `true` | Pulls property totals for the same window and filters |
| `outputFile` | temp CSV | `.csv` or `.json`. Used automatically when rows exceed `inlineRowLimit` |
| `inlineRowLimit` | `500` | Rows returned inline before switching to a file |
| `previewRows` | `25` | Inline preview size when rows go to a file |

## Setup

Requires Node 18+.

```bash
git clone https://github.com/Boston617Delta/gsc-coverage-mcp.git
cd gsc-coverage-mcp
npm install
```

### Credentials

Either of these works:

- **Service account (recommended for anything scheduled).** Create a service account and a JSON key, then add the service account's email as a user on each Search Console property (Restricted is enough). Point `GOOGLE_APPLICATION_CREDENTIALS` at the key. Service accounts don't hit the periodic re-authentication that user logins do, so scheduled jobs keep running.
- **Application Default Credentials.** `gcloud auth application-default login` with the `https://www.googleapis.com/auth/webmasters.readonly` scope. This works for interactive use, but if your Google Workspace enforces Google Cloud session control, expect to log in again every few days.

If your organization blocks service account keys (`iam.disableServiceAccountKeyCreation`, on by default for newer Google Cloud orgs), an org policy admin can lift it for a single project:

```bash
gcloud resource-manager org-policies disable-enforce iam.disableServiceAccountKeyCreation --project=YOUR_PROJECT
```

Keep the key file out of version control, readable only by you (`chmod 600`).

### Claude Code

```bash
claude mcp add gsc-coverage \
  --env GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
  -- node /path/to/gsc-coverage-mcp/src/index.js
```

### Claude Desktop

```json
{
  "mcpServers": {
    "gsc-coverage": {
      "command": "node",
      "args": ["/path/to/gsc-coverage-mcp/src/index.js"],
      "env": { "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/service-account.json" }
    }
  }
}
```

### Codex

The Codex CLI, IDE extension and desktop app share `~/.codex/config.toml`. Add:

```toml
[mcp_servers.gsc-coverage]
command = "node"
args = ["/path/to/gsc-coverage-mcp/src/index.js"]
tool_timeout_sec = 180

[mcp_servers.gsc-coverage.env]
GOOGLE_APPLICATION_CREDENTIALS = "/path/to/service-account.json"
```

Or from the CLI:

```bash
codex mcp add gsc-coverage \
  --env GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
  -- node /path/to/gsc-coverage-mcp/src/index.js
```

Codex stops a tool call after 60 seconds by default, and a pull of 100,000 rows can take longer than that, so set `tool_timeout_sec` in the config. If the desktop app can't start the server, replace `node` with the full path that `which node` prints.

## What it can't fix

- **Anonymized queries are gone.** Google withholds them before any connector, warehouse or export sees the data. The coverage block measures that gap so you can report it.
- **Google's own row limits still apply.** Google documents a ceiling of about 50,000 rows per day, per property, per search type for page and query breakdowns. For very large sites, use the [Bulk Data Export to BigQuery](https://support.google.com/webmasters/answer/12918484).
- **Historical rows include dead URLs.** GSC still reports pages you removed months ago. Check status codes, redirects, canonicals and indexability on the live site before recommending work on any URL.

## A checklist to pair with it

Before trusting any LLM output built on GSC data:

1. Request every row, and confirm `truncated` is `false`.
2. Read `clickCoveragePct`. Page-level rows should land close to the property totals, while query-level rows fall short by however much Google anonymized.
3. Treat missing as unknown, not zero. Filter for the specific URL or query before calling it lost.
4. Use the same dimensions, filters and window logic for both sides of any comparison.
5. Check every recommended URL on the live site.
6. Put the date range, dimensions, row count and coverage in the deliverable.

## Development

```bash
npm test
```

Tests use a fake Search Console client, so no credentials are needed.

## License

MIT
