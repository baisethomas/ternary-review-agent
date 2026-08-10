import "server-only";
import { Redis } from "@upstash/redis";

const dashboardChangeKey = "ternary:dashboard:change:v1";
let redis: Redis | null = null;

function configuredDashboardRedis() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  redis ??= new Redis({ url, token });
  return redis;
}

export async function getDashboardChangeCursor() {
  const store = configuredDashboardRedis();
  if (!store) throw new Error("Dashboard change storage is not configured");
  return await store.get<number>(dashboardChangeKey) ?? 0;
}

export async function announceDashboardChange() {
  const store = configuredDashboardRedis();
  if (!store) return;
  try {
    await store.incr(dashboardChangeKey);
  } catch (error) {
    console.error("Unable to announce dashboard change", error);
  }
}
