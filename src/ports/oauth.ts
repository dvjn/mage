// What signing in to a provider account needs from the provider's OAuth server: a device code the
// person enters at the provider, and token refresh.

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
