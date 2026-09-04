export const FIXTURE_TIME = '2026-09-04T00:00:00.000Z';

export function fixtureUser(overrides = {}) {
  return {
    id: 'alice',
    displayName: 'Alice',
    uuid: '00000000-0000-4000-8000-000000000001',
    tokenHash: 'sha256:3ba3f5f43b92602683c19aee62a20342b084dd5971ddd33808d81a328879a547',
    status: 'active',
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    disabledAt: null,
    revokedAt: null,
    ...overrides,
  };
}

export function fixtureState(overrides = {}) {
  const state = {
    schemaVersion: 2,
    revision: 1,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    gateway: {
      host: { kind: 'dns', value: 'vpn.example.com' },
      advertisedPort: 443,
      listenPort: 443,
      publicBaseUrl: 'https://vpn.example.com/subscriptions',
    },
    reality: {
      serverName: 'www.example.com',
      privateKey: 'UuMBgl7MXTPx9inmQp2UC7Jcnwc6XYbwDNebonM-FCc', // gitleaks:allow -- deterministic test vector
      publicKey: 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0',
      shortId: 'a1b2c3d4',
    },
    tailscale: {
      hostname: 'vpn-gateway',
      stateDirectory: '/var/lib/vpn-gateway/tailscale',
      authKey: 'tskey-auth-test-secret',
      apiKey: 'tskey-api-test-secret',
      exitNode: '100.64.0.2',
    },
    health: {
      listenPort: 19080,
      username: 'vpn-health',
      password: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc',
      target: { host: 'www.example.com', port: 443 },
    },
    admin: {
      scrypt: {
        algorithm: 'scrypt',
        salt: 'AQEBAQEBAQEBAQEBAQEBAQ',
        hash: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
        keyLength: 32,
        cost: 16384,
        blockSize: 8,
        parallelization: 1,
      },
    },
    users: [fixtureUser()],
  };
  return { ...state, ...overrides };
}
