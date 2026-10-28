// Search Console Search Analytics helpers: paginated pulls plus a coverage report.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const API_PAGE_SIZE = 25000;
const API_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';

// Thin REST client. `request` is a google-auth-library client's request method,
// injected so tests can swap it out.
export function makeClient(request) {
  return {
    async listSites() {
      const res = await request({ url: `${API_BASE}/sites`, method: 'GET' });
      return res.data.siteEntry ?? [];
    },
    async query(siteUrl, body) {
      const res = await request({
        url: `${API_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
        method: 'POST',
        data: body,
      });
      return res.data.rows ?? [];
    },
  };
}

// Build the request body shared by the paged pull and the totals pull.
export function baseBody(args) {
  const body = {
    startDate: args.startDate,
    endDate: args.endDate,
    type: args.type ?? 'web',
    dataState: args.dataState ?? 'final',
  };
  if (args.aggregationType) body.aggregationType = args.aggregationType;
  if (args.filters?.length) {
    body.dimensionFilterGroups = [{ groupType: 'and', filters: args.filters }];
  }
  return body;
}

// Page through startRow until the API runs dry or maxRows is reached.
export async function fetchAllRows(client, siteUrl, args) {
  const maxRows = args.maxRows ?? 100000;
  const rows = [];
  let pages = 0;
  let apiExhausted = false;

  while (rows.length < maxRows) {
    const rowLimit = Math.min(API_PAGE_SIZE, maxRows - rows.length);
    const batch = await client.query(siteUrl, {
      ...baseBody(args),
      dimensions: args.dimensions,
      rowLimit,
      startRow: rows.length,
    });
    pages += 1;
    rows.push(...batch);
    if (batch.length < rowLimit) {
      apiExhausted = true;
      break;
    }
  }

  return { rows, pages, apiExhausted, hitMaxRows: !apiExhausted };
}

// Property totals for the same window, filters and search type, with no dimensions.
export async function fetchTotals(client, siteUrl, args) {
  const [row] = await client.query(siteUrl, { ...baseBody(args), rowLimit: 1 });
  return { clicks: row?.clicks ?? 0, impressions: row?.impressions ?? 0 };
}

const round = (n, places = 1) => Math.round(n * 10 ** places) / 10 ** places;
const pct = (part, whole) => (whole > 0 ? round((part / whole) * 100) : null);

export function buildCoverage({ rows, pages, apiExhausted, hitMaxRows }, totals, args) {
  const sums = rows.reduce(
    (acc, r) => ({ clicks: acc.clicks + r.clicks, impressions: acc.impressions + r.impressions }),
    { clicks: 0, impressions: 0 },
  );
  const notes = [];

  if (hitMaxRows) {
    notes.push(
      `Stopped at maxRows (${args.maxRows ?? 100000}). More rows exist. Raise maxRows, narrow the date range, or add filters before treating this as complete.`,
    );
  }
  if (args.dimensions.some((d) => d === 'query')) {
    notes.push(
      'Query rows never add up to property totals: Google drops anonymised and rare queries. A coverage gap here is privacy filtering, not missing pages.',
    );
  }
  if (args.dimensions.includes('page') && (args.aggregationType ?? 'auto') !== 'byProperty') {
    notes.push(
      'Page rows are aggregated by page, so their sums can exceed property totals when one search shows several of your URLs.',
    );
  }
  notes.push(
    'Missing from these rows is not the same as zero. Check any absent URL or query with a direct filter before calling it lost or invisible.',
  );

  return {
    window: { startDate: args.startDate, endDate: args.endDate, type: args.type ?? 'web', dataState: args.dataState ?? 'final' },
    dimensions: args.dimensions,
    filters: args.filters ?? [],
    rowsReturned: rows.length,
    pagesFetched: pages,
    apiExhausted,
    truncated: hitMaxRows,
    propertyTotals: totals,
    rowSums: { clicks: sums.clicks, impressions: sums.impressions },
    clickCoveragePct: pct(sums.clicks, totals?.clicks),
    impressionCoveragePct: pct(sums.impressions, totals?.impressions),
    notes,
  };
}

// Flatten API rows ({keys: [...], clicks, ...}) into named columns.
export function flattenRows(rows, dimensions) {
  return rows.map((r) => {
    const out = {};
    dimensions.forEach((d, i) => {
      out[d] = r.keys?.[i];
    });
    out.clicks = r.clicks;
    out.impressions = r.impressions;
    out.ctr = round(r.ctr * 100, 2);
    out.position = round(r.position, 2);
    return out;
  });
}

const csvCell = (v) => {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export async function writeRows(flat, outputFile) {
  const path = outputFile ?? join(tmpdir(), 'gsc-coverage-mcp', `pull-${Date.now()}.csv`);
  await mkdir(dirname(path), { recursive: true });
  if (extname(path).toLowerCase() === '.json') {
    await writeFile(path, JSON.stringify(flat, null, 2));
  } else {
    const cols = flat.length ? Object.keys(flat[0]) : [];
    const lines = [cols.join(','), ...flat.map((r) => cols.map((c) => csvCell(r[c])).join(','))];
    await writeFile(path, lines.join('\n') + '\n');
  }
  return path;
}

// Full tool flow: paged pull, totals, coverage, then inline rows or a file.
export async function searchAnalytics(client, args) {
  const pull = await fetchAllRows(client, args.siteUrl, args);
  const totals = args.includeCoverage === false ? null : await fetchTotals(client, args.siteUrl, args);
  const coverage = buildCoverage(pull, totals, args);
  const flat = flattenRows(pull.rows, args.dimensions);
  const inlineLimit = args.inlineRowLimit ?? 500;

  if (args.outputFile || flat.length > inlineLimit) {
    const file = await writeRows(flat, args.outputFile);
    return { coverage, file, preview: flat.slice(0, args.previewRows ?? 25) };
  }
  return { coverage, rows: flat };
}
