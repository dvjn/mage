// What signing in to a provider account needs from the provider's OAuth server: a device code the
// person enters at the provider, or an authorization whose code the provider shows the person to
// paste back; and token refresh.

export interface OAuthTokens {
  access: string;
  refresh: string;
  expiresIn: number;
  accountId: string | null;
  email: string | null;
  plan: string | null;
}

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "approved"; code: string; codeVerifier: string };

export interface DeviceOAuth {
  startDevice(signal?: AbortSignal): Promise<DeviceCode>;
  // Throws when the provider ends the sign-in.
  pollDevice(device: DeviceCode, signal?: AbortSignal): Promise<DevicePoll>;
  exchangeDevice(
    approval: { code: string; codeVerifier: string },
    signal?: AbortSignal,
  ): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
}

// An authorization to open at the provider, with the state and PKCE verifier it was made with.
export interface Authorization {
  state: string;
  codeVerifier: string;
  authorizeUrl: string;
}

export interface CodeOAuth {
  // A fresh authorization with its own state and verifier.
  authorize(): Authorization;
  exchange(
    grant: { code: string; codeVerifier: string; state: string },
    signal?: AbortSignal,
  ): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
}
