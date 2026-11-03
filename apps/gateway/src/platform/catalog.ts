import { usdToUsdcAtomic } from "@mx/shared";
import type { Handler, PaidHandler, Precheck, PricedResource, Product, ProductRoutes } from "./product";

/** Top-level /v1 segments owned by the platform; a product id may not take them. */
export const RESERVED_PRODUCT_IDS = new Set(["admin", "credits", "payments", "policy", "products", "stripe", "status", "openapi", "health", "metrics"]);

const PRODUCT_ID = /^[a-z][a-z0-9-]{1,31}$/;
const RESOURCE_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

export interface PaidRoute {
  product: Product;
  resource: PricedResource;
  /** Absolute canonical path, `/v1/<product><resource.path>`. */
  path: string;
  handler: PaidHandler<unknown>;
  precheck?: Precheck<unknown>;
}

export interface FreeRoute {
  product: Product;
  path: string;
  legacyPaths: string[];
  handler: Handler;
}

export interface AdminRoute {
  product: Product;
  method: "GET" | "POST" | "PUT";
  /** Path relative to /admin, e.g. `/maritime/conditions/panama-draught`. */
  path: string;
  handler: Handler;
}

export class CatalogError extends Error {
  override name = "CatalogError";
}

/** Resource ids are `<productId>.<name>`; the product id is the ledger revenue namespace. */
export function productOfResource(resourceId: string): string {
  const dot = resourceId.indexOf(".");
  const product = dot > 0 ? resourceId.slice(0, dot) : "";
  if (!PRODUCT_ID.test(product) || !RESOURCE_NAME.test(resourceId.slice(dot + 1))) throw new CatalogError(`invalid resource id ${JSON.stringify(resourceId)}`);
  return product;
}

const pathParams = (pattern: string) => [...pattern.matchAll(/:(\w+)/g)].map((m) => m[1]!);

/**
 * The set of products the gateway hosts. Validates every product at construction, so a bad
 * product definition fails at boot, never on a paid request.
 */
export class Catalog {
  readonly products: readonly Product[];
  readonly paid: readonly PaidRoute[];
  readonly free: readonly FreeRoute[];
  readonly admin: readonly AdminRoute[];
  private readonly byResource = new Map<string, PricedResource>();
  private readonly byId = new Map<string, Product>();

  constructor(products: Product[]) {
    if (products.length === 0) throw new CatalogError("at least one product is required");
    const paid: PaidRoute[] = [];
    const free: FreeRoute[] = [];
    const admin: AdminRoute[] = [];
    const routeKeys = new Set<string>();
    const claim = (key: string) => {
      if (routeKeys.has(key)) throw new CatalogError(`route registered twice: ${key}`);
      routeKeys.add(key);
    };

    for (const p of products) {
      if (!PRODUCT_ID.test(p.id)) throw new CatalogError(`invalid product id ${JSON.stringify(p.id)}`);
      if (RESERVED_PRODUCT_IDS.has(p.id)) throw new CatalogError(`product id ${p.id} is reserved by the platform`);
      if (this.byId.has(p.id)) throw new CatalogError(`duplicate product id ${p.id}`);
      this.byId.set(p.id, p);

      for (const r of p.resources) this.validateResource(p, r);

      const registered = new Map<string, PaidRoute>();
      const routes: ProductRoutes<unknown> = {
        paid: (resourceId, handler, opts) => {
          const resource = p.resources.find((r) => r.id === resourceId);
          if (!resource) throw new CatalogError(`${p.id}: handler for undeclared resource ${resourceId}`);
          if (registered.has(resourceId)) throw new CatalogError(`${p.id}: resource ${resourceId} has two handlers`);
          const route: PaidRoute = { product: p, resource, path: `/v1/${p.id}${resource.path}`, handler, precheck: opts?.precheck };
          claim(`GET ${route.path}`);
          for (const l of resource.legacyPaths ?? []) claim(`GET ${l}`);
          registered.set(resourceId, route);
        },
        free: (path, handler, opts) => {
          if (!path.startsWith("/")) throw new CatalogError(`${p.id}: free path must start with /`);
          const route: FreeRoute = { product: p, path: `/v1/${p.id}${path}`, legacyPaths: opts?.legacyPaths ?? [], handler };
          claim(`GET ${route.path}`);
          for (const l of route.legacyPaths) claim(`GET ${l}`);
          free.push(route);
        },
        admin: (method, path, handler) => {
          if (!path.startsWith("/")) throw new CatalogError(`${p.id}: admin path must start with /`);
          const route: AdminRoute = { product: p, method, path: `/${p.id}${path}`, handler };
          claim(`${method} /admin${route.path}`);
          admin.push(route);
        },
      };
      p.routes(routes as ProductRoutes<never>);

      const missing = p.resources.filter((r) => !registered.has(r.id)).map((r) => r.id);
      if (missing.length) throw new CatalogError(`${p.id}: no handler for ${missing.join(", ")}`);
      paid.push(...registered.values());
    }

    this.products = products;
    this.paid = paid;
    this.free = free;
    this.admin = admin;
  }

  get resources(): PricedResource[] {
    return [...this.byResource.values()];
  }

  resource(id: string): PricedResource | undefined {
    return this.byResource.get(id);
  }

  product(id: string): Product | undefined {
    return this.byId.get(id);
  }

  private validateResource(p: Product, r: PricedResource) {
    const prefix = `${p.id}.`;
    if (!r.id.startsWith(prefix) || !RESOURCE_NAME.test(r.id.slice(prefix.length))) throw new CatalogError(`${p.id}: resource id ${r.id} must be ${prefix}<name>`);
    if (this.byResource.has(r.id)) throw new CatalogError(`duplicate resource id ${r.id}`);
    if (!r.path.startsWith("/")) throw new CatalogError(`${r.id}: path must start with /`);
    if (r.pricing.kind !== "fixed") throw new CatalogError(`${r.id}: unsupported pricing kind ${(r.pricing as { kind: string }).kind}`);
    let atomic: bigint;
    try {
      atomic = usdToUsdcAtomic(r.pricing.priceUsd);
    } catch {
      throw new CatalogError(`${r.id}: priceUsd ${r.pricing.priceUsd} is not a USD amount with ≤ 6 decimals`);
    }
    if (atomic <= 0n) throw new CatalogError(`${r.id}: priceUsd must be positive`);
    if (!Number.isSafeInteger(r.pricing.creditsGbpMicros) || r.pricing.creditsGbpMicros <= 0) throw new CatalogError(`${r.id}: creditsGbpMicros must be a positive integer`);
    const declared = new Set((r.parameters ?? []).filter((x) => x.in === "path").map((x) => x.name));
    const inPath = pathParams(r.path);
    for (const name of inPath) if (!declared.has(name)) throw new CatalogError(`${r.id}: path parameter :${name} is not declared`);
    for (const name of declared) if (!inPath.includes(name)) throw new CatalogError(`${r.id}: declared path parameter ${name} is not in the path`);
    for (const l of r.legacyPaths ?? []) {
      if (!l.startsWith("/v1/")) throw new CatalogError(`${r.id}: legacy path ${l} must be absolute under /v1/`);
      if (pathParams(l).sort().join() !== [...inPath].sort().join()) throw new CatalogError(`${r.id}: legacy path ${l} must take the same parameters as ${r.path}`);
    }
    this.byResource.set(r.id, r);
  }
}
