const knownAdHosts = [
  "static.content-sync.xyz",
  "tsyndicate.com",
  "wishapptrack.com",
  "mengmei8.com",
  "ad.twinrdengine.com",
  "go.marzaent.com",
] as const;

export function isKnownAdRequest(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname.toLowerCase();
  if (knownAdHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return true;
  if (hostname !== "stripchat.com" && !hostname.endsWith(".stripchat.com")) return false;
  return /popunder/i.test(parsed.searchParams.get("trafficType") ?? "");
}
