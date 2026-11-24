import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class ProtogridApi implements ICredentialType {
	name = 'protogridApi';

	displayName = 'Protogrid API';

	icon = { light: 'file:protogrid.svg', dark: 'file:protogrid.dark.svg' } as const;

	documentationUrl = 'https://docs.protogrid.dev/reference/api-keys/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'A free key from protogrid.dev/account raises the request limits. The node also works without a credential.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-API-Key': '={{$credentials.apiKey}}',
			},
		},
	};

	// Any value in X-API-Key is checked: a key that is malformed, unknown or revoked is refused with 401 on every route.
	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.protogrid.dev',
			url: '/v1/search',
			qs: { q: 'mcp', limit: 1 },
		},
	};
}
