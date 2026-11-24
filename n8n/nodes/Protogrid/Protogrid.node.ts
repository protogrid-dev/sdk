import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
	type INodeExecutionData,
	type INodeProperties,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';

const BASE_URL = 'https://api.protogrid.dev';

const QUALITY_FLAGS = [
	{
		name: 'Known Vulnerabilities',
		value: 'known-vulns',
		description:
			'A dependency has a high or critical advisory with a fix, or is a known malicious package',
	},
	{
		name: 'Hidden Text',
		value: 'hidden-text',
		description:
			'A tool, prompt or resource definition holds text a model reads but a person does not see',
	},
	{
		name: 'Tool Poisoning',
		value: 'tool-poisoning',
		description: 'A tool, prompt or resource definition holds instructions aimed at the model',
	},
	{
		name: 'Outdated MCP SDK',
		value: 'outdated-mcp-sdk',
		description: 'The official MCP SDK version in use has a known advisory',
	},
];

const CLASSES = [
	{ name: 'R0: Nothing to Set Up', value: 'R0' },
	{ name: 'R1: Needs a Key', value: 'R1' },
	{ name: 'R2: Needs a Sign-In (OAuth)', value: 'R2' },
];

const show = (operation: string) => ({
	displayOptions: { show: { resource: ['server'], operation: [operation] } },
});

/** The rules shared by Search and Check Against Rules. The defaults refuse what no agent should load. */
const rules = (operation: string): INodeProperties[] => [
	{
		displayName: 'Connection Classes',
		name: 'classes',
		type: 'multiOptions',
		options: CLASSES,
		default: ['R0', 'R1', 'R2'],
		description:
			'Remote servers only: n8n connects to MCP servers over HTTP. R2 servers need the MCP OAuth2 sign-in of the MCP Client Tool.',
		...show(operation),
	},
	{
		displayName: 'Exclude Servers Flagged For',
		name: 'excludeQualityFlags',
		type: 'multiOptions',
		options: QUALITY_FLAGS,
		default: ['known-vulns', 'hidden-text', 'tool-poisoning'],
		description:
			'A server with any of these quality flags is left out (Search) or fails (Check Against Rules)',
		...show(operation),
	},
	{
		displayName: 'Exclude Servers That Charge Per Call',
		name: 'excludePaid',
		type: 'boolean',
		default: true,
		description:
			'Whether to leave out servers that charge per call (x402), which need a wallet to use',
		...show(operation),
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		...show(operation),
		options: [
			{
				displayName: 'Minimum Quality Score',
				name: 'minQuality',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 100 },
				default: 70,
				description:
					'Lowest quality score accepted (0 to 100). Servers that are not scored are left out.',
			},
			{
				displayName: 'Minimum Trust Score',
				name: 'minTrust',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 100 },
				default: 50,
				description: 'Lowest trust score accepted (0 to 100)',
			},
			{
				displayName: 'Owner Verified Only',
				name: 'ownerVerified',
				type: 'boolean',
				default: true,
				description: 'Whether to accept only servers whose owner proved control of them',
			},
		],
	},
];

export class Protogrid implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Protogrid',
		name: 'protogrid',
		icon: { light: 'file:protogrid.svg', dark: 'file:protogrid.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle:
			'={{ {"search": "Search servers", "gate": "Check against rules", "connection": "Get connection"}[$parameter["operation"]] }}',
		description:
			'Find MCP servers by what they do, check them against your rules, and get the connection for the MCP Client Tool',
		defaults: { name: 'Protogrid' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'protogridApi', required: false }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Server', value: 'server' }],
				default: 'server',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['server'] } },
				options: [
					{
						name: 'Search',
						value: 'search',
						action: 'Search servers',
						description: 'Find MCP servers by what they do, best match first',
					},
					{
						name: 'Check Against Rules',
						value: 'gate',
						action: 'Check a server against rules',
						description: 'Whether one MCP server passes your rules, with every rule it breaks',
					},
					{
						name: 'Get Connection',
						value: 'connection',
						action: 'Get the connection of a server',
						description: 'The endpoint, transport and headers to set in the MCP Client Tool',
					},
				],
				default: 'search',
			},
			{
				displayName: 'Query',
				name: 'query',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. send an email',
				description: 'What the MCP server should do, in plain words',
				...show('search'),
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 50 },
				default: 50,
				description: 'Max number of results to return',
				...show('search'),
			},
			...rules('search'),
			{
				displayName: 'Server Name',
				name: 'server',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'e.g. io.github.owner/server',
				description: 'The registry name of the server, as Search returns it',
				displayOptions: { show: { resource: ['server'], operation: ['gate', 'connection'] } },
			},
			...rules('gate'),
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		const keyed = Boolean(this.getNode().credentials?.protogridApi);
		const signal = this.getExecutionCancelSignal();
		const get = async (url: string, qs: IDataObject, itemIndex: number): Promise<IDataObject> => {
			const req: IHttpRequestOptions = {
				method: 'GET',
				baseURL: BASE_URL,
				url,
				qs,
				json: true,
				headers: { Accept: 'application/json' },
				...(signal ? { abortSignal: signal } : {}),
			};
			try {
				return (await (keyed
					? this.helpers.httpRequestWithAuthentication.call(this, 'protogridApi', req)
					: this.helpers.httpRequest(req))) as IDataObject;
			} catch (error) {
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex });
			}
		};

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				if (operation === 'search') {
					const query = (this.getNodeParameter('query', i) as string).trim();
					if (!query)
						throw new NodeOperationError(this.getNode(), 'Query is empty', { itemIndex: i });
					const qs: IDataObject = {
						q: query,
						limit: this.getNodeParameter('limit', i) as number,
						...ruleQuery(this, i),
					};
					const res = await get('/v1/search', qs, i);
					for (const r of (res.results as IDataObject[]) ?? [])
						out.push({ json: r, pairedItem: { item: i } });
				} else {
					const server = (this.getNodeParameter('server', i) as string).trim();
					if (!server)
						throw new NodeOperationError(this.getNode(), 'Server Name is empty', { itemIndex: i });
					const path = `/v1/servers/${encodeURIComponent(server)}`;
					if (operation === 'gate') {
						const qs = ruleQuery(this, i);
						if (Object.keys(qs).length === 0)
							throw new NodeOperationError(this.getNode(), 'Set at least one rule to check', {
								itemIndex: i,
							});
						out.push({ json: await get(`${path}/gate`, qs, i), pairedItem: { item: i } });
					} else if (operation === 'connection') {
						out.push({
							json: forMcpClientTool(await get(`${path}/connection`, { target: 'mcpServers' }, i)),
							pairedItem: { item: i },
						});
					} else {
						throw new NodeOperationError(this.getNode(), `Unknown operation ${operation}`, {
							itemIndex: i,
						});
					}
				}
			} catch (error) {
				const nodeError =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				if (!this.continueOnFail()) throw nodeError;
				out.push({ json: { error: nodeError.message }, pairedItem: { item: i } });
			}
		}
		return [out];
	}
}

/** The rules of an item as the API's query parameters; a rule left empty is not sent. */
function ruleQuery(ctx: IExecuteFunctions, i: number): IDataObject {
	const qs: IDataObject = {};
	const classes = ctx.getNodeParameter('classes', i, []) as string[];
	if (classes.length) qs.class = classes.join(',');
	const flags = ctx.getNodeParameter('excludeQualityFlags', i, []) as string[];
	if (flags.length) qs.exclude_quality_flags = flags.join(',');
	if (ctx.getNodeParameter('excludePaid', i, true) as boolean) qs.paid = false;
	const o = ctx.getNodeParameter('options', i, {}) as {
		minQuality?: number;
		minTrust?: number;
		ownerVerified?: boolean;
	};
	if (o.minQuality !== undefined) qs.min_quality = o.minQuality;
	if (o.minTrust !== undefined) qs.min_trust = o.minTrust;
	if (o.ownerVerified) qs.owner_verified = true;
	return qs;
}

/**
 * The registry's connection block as the MCP Client Tool's fields: endpoint URL, server transport and the headers to
 * set, with `${NAME}` placeholders for the secrets you hold. Local packages have no endpoint: n8n cannot run them.
 */
export function forMcpClientTool(res: IDataObject): IDataObject {
	const entries = Object.values(
		((res.connection as IDataObject)?.mcpServers as IDataObject) ?? {},
	) as IDataObject[];
	const entry = entries[0] ?? {};
	const remote = typeof entry.url === 'string';
	return {
		server: res.server,
		class: res.class,
		remote,
		endpointUrl: remote ? entry.url : null,
		serverTransport: remote ? (entry.type === 'sse' ? 'sse' : 'httpStreamable') : null,
		headers: remote ? ((entry.headers as IDataObject) ?? {}) : {},
		secrets: res.secrets ?? [],
		authType: res.auth_type ?? null,
		humanSteps: res.human_steps ?? [],
		note: remote
			? 'Set these in the MCP Client Tool. Replace each ${NAME} with a value you hold; protogrid never receives it.'
			: 'A local package: the MCP Client Tool connects to remote servers only.',
	};
}
