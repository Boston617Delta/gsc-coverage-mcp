#!/usr/bin/env node
// MCP server entry point: registers the Search Console tools over stdio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import { makeClient, searchAnalytics } from './gsc.js';

// Uses GOOGLE_APPLICATION_CREDENTIALS (service account key) when set, otherwise ADC.
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
let client;
async function getClient() {
  if (!client) {
    const authClient = await auth.getClient();
    client = makeClient((opts) => authClient.request(opts));
  }
  return client;
}

const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const asError = (err) => ({
  isError: true,
  content: [{ type: 'text', text: `Search Console request failed: ${err.response?.data?.error?.message ?? err.message}` }],
});

const server = new McpServer({ name: 'gsc-coverage-mcp', version: '0.1.0' });

server.registerTool(
  'list_sites',
  {
    description: 'List the Search Console properties these credentials can read, with permission level.',
    inputSchema: {},
  },
  async () => {
    try {
      return asText(await (await getClient()).listSites());
    } catch (err) {
      return asError(err);
    }
  },
);

const filterSchema = z.object({
  dimension: z.enum(['query', 'page', 'country', 'device', 'searchAppearance']),
  operator: z.enum(['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex']).default('equals'),
  expression: z.string(),
});

server.registerTool(
  'search_analytics',
  {
    description: [
      'Pull Search Console performance rows, paging past the 25,000-row API cap until Google has no more rows (or maxRows is hit).',
      'Every response includes a coverage block: rows returned, pages fetched, whether the pull was truncated,',
      'property totals for the same window, and the share of clicks and impressions the rows account for.',
      'Read the coverage block and its notes before drawing conclusions. Large pulls are written to a CSV/JSON file',
      'and only a preview comes back inline.',
    ].join(' '),
    inputSchema: {
      siteUrl: z.string().describe('Property exactly as Search Console lists it, e.g. "sc-domain:example.com" or "https://www.example.com/".'),
      startDate: z.string().describe('YYYY-MM-DD'),
      endDate: z.string().describe('YYYY-MM-DD'),
      dimensions: z
        .array(z.enum(['query', 'page', 'country', 'device', 'date', 'searchAppearance', 'hour']))
        .default(['query'])
        .describe('Breakdown dimensions. Each added dimension multiplies the row count.'),
      type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).default('web'),
      dataState: z.enum(['final', 'all', 'hourly_all']).default('final').describe('"all" includes fresh, not-yet-final data.'),
      aggregationType: z.enum(['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel']).optional(),
      filters: z.array(filterSchema).optional().describe('ANDed dimension filters.'),
      maxRows: z.number().int().positive().max(1000000).default(100000).describe('Safety cap across all pages.'),
      includeCoverage: z.boolean().default(true).describe('Also pull property totals and compute coverage.'),
      outputFile: z.string().optional().describe('Write all rows here (.csv or .json). Defaults to a temp CSV when rows exceed inlineRowLimit.'),
      inlineRowLimit: z.number().int().positive().default(500).describe('Return rows inline only up to this many.'),
      previewRows: z.number().int().positive().default(25).describe('Rows to show inline when rows go to a file.'),
    },
  },
  async (args) => {
    try {
      return asText(await searchAnalytics(await getClient(), args));
    } catch (err) {
      return asError(err);
    }
  },
);

await server.connect(new StdioServerTransport());
