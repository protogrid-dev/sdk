/** The Protogrid node's execute() with a scripted n8n context: what it asks the registry and what it outputs. */
import { describe, expect, it } from 'vitest';
import {
	NodeApiError,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
} from 'n8n-workflow';
import { Protogrid, forMcpClientTool } from '../nodes/Protogrid/Protogrid.node';

interface Call {
	auth: string | null;
	req: IHttpRequestOptions;
}

function run(
	params: IDataObject[],
	answer: (req: IHttpRequestOptions) => unknown,
	opts: { keyed?: boolean; continueOnFail?: boolean } = {},
) {
	const calls: Call[] = [];
	const node = {
		id: '1',
		name: 'Protogrid',
		type: '@protogrid/n8n-nodes-protogrid.protogrid',
		typeVersion: 1,
		position: [0, 0] as [number, number],
		parameters: {},
		...(opts.keyed ? { credentials: { protogridApi: { id: 'c', name: 'key' } } } : {}),
	};
	const respond = async (auth: string | null, req: IHttpRequestOptions) => {
		calls.push({ auth, req });
		const a = answer(req);
		if (a instanceof Error) throw a;
		return a;
	};
	const ctx = {
		getInputData: () => params.map(() => ({ json: {} })),
		getNodeParameter: (name: string, i: number, fallback?: unknown) => params[i]![name] ?? fallback,
		getNode: () => node,
		getExecutionCancelSignal: () => undefined,
		continueOnFail: () => opts.continueOnFail ?? false,
		helpers: {
			httpRequest: (req: IHttpRequestOptions) => respond(null, req),
			httpRequestWithAuthentication: (cred: string, req: IHttpRequestOptions) => respond(cred, req),
		},
	} as unknown as IExecuteFunctions;
	return { calls, result: new Protogrid().execute.call(ctx) };
}

const DEFAULT_RULES = {
	classes: ['R0', 'R1', 'R2'],
	excludeQualityFlags: ['known-vulns', 'hidden-text', 'tool-poisoning'],
	excludePaid: true,
	options: {},
};

describe('Search', () => {
	it('sends the query and rules, and outputs one item per server, paired with its input', async () => {
		const { calls, result } = run(
			[{ operation: 'search', query: ' send an email ', limit: 2, ...DEFAULT_RULES }],
			() => ({ results: [{ name: 'io.github.a/mail' }, { name: 'io.github.b/mail' }] }),
		);
		const [items] = await result;
		expect(items!.map((x) => x.json.name)).toEqual(['io.github.a/mail', 'io.github.b/mail']);
		expect(items!.map((x) => x.pairedItem)).toEqual([{ item: 0 }, { item: 0 }]);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.auth).toBeNull();
		expect(calls[0]!.req).toMatchObject({
			method: 'GET',
			baseURL: 'https://api.protogrid.dev',
			url: '/v1/search',
			qs: {
				q: 'send an email',
				limit: 2,
				class: 'R0,R1,R2',
				exclude_quality_flags: 'known-vulns,hidden-text,tool-poisoning',
				paid: false,
			},
		});
	});

	it('sends the options set and leaves out the rules left empty; a credential authenticates the request', async () => {
		const { calls, result } = run(
			[
				{
					operation: 'search',
					query: 'mail',
					limit: 5,
					classes: [],
					excludeQualityFlags: [],
					options: { minQuality: 80, minTrust: 60, ownerVerified: true },
				},
			],
			() => ({ results: [] }),
			{ keyed: true },
		);
		expect((await result)[0]).toEqual([]);
		expect(calls[0]!.auth).toBe('protogridApi');
		expect(calls[0]!.req.qs).toEqual({
			q: 'mail',
			limit: 5,
			paid: false,
			min_quality: 80,
			min_trust: 60,
			owner_verified: true,
		});
	});

	it('leaves out servers that charge per call unless told not to, also when the parameter is missing', async () => {
		const { calls, result } = run(
			[
				{ operation: 'search', query: 'mail', classes: [], excludeQualityFlags: [] },
				{
					operation: 'search',
					query: 'mail',
					classes: [],
					excludeQualityFlags: [],
					excludePaid: false,
				},
			],
			() => ({ results: [] }),
		);
		await result;
		expect(calls[0]!.req.qs).toMatchObject({ paid: false });
		expect(calls[1]!.req.qs).not.toHaveProperty('paid');
	});

	it('refuses an empty query without asking the registry', async () => {
		const { calls, result } = run(
			[{ operation: 'search', query: '  ', ...DEFAULT_RULES }],
			() => ({}),
		);
		await expect(result).rejects.toThrow('Query is empty');
		expect(calls).toHaveLength(0);
	});
});

describe('Check Against Rules', () => {
	it("asks the server's gate with the rules and outputs the answer", async () => {
		const gate = {
			server: 'io.github.a/mail',
			pass: false,
			failed: [{ rule: 'min_quality', detail: 'quality 60 is under 70' }],
		};
		const { calls, result } = run(
			[
				{
					operation: 'gate',
					server: 'io.github.a/mail',
					...DEFAULT_RULES,
					options: { minQuality: 70 },
				},
			],
			() => gate,
		);
		expect((await result)[0]![0]!.json).toEqual(gate);
		expect(calls[0]!.req.url).toBe('/v1/servers/io.github.a%2Fmail/gate');
		expect(calls[0]!.req.qs).toMatchObject({ min_quality: 70, class: 'R0,R1,R2' });
	});

	it('needs at least one rule', async () => {
		const { calls, result } = run(
			[
				{
					operation: 'gate',
					server: 'io.github.a/mail',
					classes: [],
					excludeQualityFlags: [],
					excludePaid: false,
					options: {},
				},
			],
			() => ({}),
		);
		await expect(result).rejects.toThrow('Set at least one rule');
		expect(calls).toHaveLength(0);
	});
});

describe('Get Connection', () => {
	it('outputs the fields of the MCP Client Tool', async () => {
		const { calls, result } = run(
			[{ operation: 'connection', server: 'io.github.s/spend' }],
			() => ({
				server: 'io.github.s/spend',
				class: 'R1',
				auth_type: 'api_key',
				human_steps: [],
				secrets: [{ name: 'api_key', where: 'header:Authorization' }],
				connection: {
					mcpServers: {
						spend: {
							type: 'http',
							url: 'https://spend.example/mcp',
							headers: { Authorization: 'Bearer ${api_key}' },
						},
					},
				},
			}),
		);
		expect(calls[0]!.req).toMatchObject({
			url: '/v1/servers/io.github.s%2Fspend/connection',
			qs: { target: 'mcpServers' },
		});
		expect((await result)[0]![0]!.json).toMatchObject({
			server: 'io.github.s/spend',
			class: 'R1',
			remote: true,
			endpointUrl: 'https://spend.example/mcp',
			serverTransport: 'httpStreamable',
			headers: { Authorization: 'Bearer ${api_key}' },
			secrets: [{ name: 'api_key', where: 'header:Authorization' }],
		});
	});

	it('maps SSE, and a local package has no endpoint', () => {
		expect(
			forMcpClientTool({
				connection: { mcpServers: { x: { type: 'sse', url: 'https://x.example/sse' } } },
			}),
		).toMatchObject({ serverTransport: 'sse', endpointUrl: 'https://x.example/sse', headers: {} });
		expect(
			forMcpClientTool({
				class: 'L0',
				connection: { mcpServers: { x: { command: 'npx', args: ['-y', 'x'] } } },
			}),
		).toMatchObject({ remote: false, endpointUrl: null, serverTransport: null });
	});
});

describe('errors', () => {
	const notFound = () =>
		Object.assign(new Error('Request failed with status code 404'), { httpCode: '404' });

	it('a registry error fails the node with a NodeApiError', async () => {
		const { result } = run([{ operation: 'connection', server: 'io.github.nope/x' }], notFound);
		await expect(result).rejects.toBeInstanceOf(NodeApiError);
	});

	it('with Continue On Fail, the failed item carries the error and the others go on', async () => {
		const { result } = run(
			[
				{ operation: 'connection', server: 'io.github.nope/x' },
				{ operation: 'gate', server: 'io.github.a/mail', ...DEFAULT_RULES },
			],
			(req) => (req.url.includes('nope') ? notFound() : { pass: true }),
			{ continueOnFail: true },
		);
		const [items] = await result;
		expect(items!.map((x) => x.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
		expect(items![0]!.json.error).toEqual(expect.any(String));
		expect(items![1]!.json).toEqual({ pass: true });
	});
});
