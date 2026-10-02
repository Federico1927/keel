import { apiEndpoint } from "@hullwise/config";
/**
 * Browser code of the first-party pixel. Two forms: a script Hullwise serves for any storefront, and
 * the body of a Shopify "custom pixel" (Settings → Customer events), which runs in Shopify's
 * sandbox and listens to its standard events. Both keep a long-lived anonymous id and a
 * 30-minute session id in first-party cookies on the store's own domain and post batches to Hullwise.
 */

/** Served at /api/px/<key>/script.js. Exposes `window.hullwise.track(event, props)` and `window.hullwise.identify(email)`. */
export function browserScript(collectUrl: string): string {
  return `(function(){
  var U=${JSON.stringify(collectUrl)},Y=31536e6,S=18e5;
  function c(n){var m=document.cookie.match(new RegExp("(?:^|; )"+n+"=([^;]*)"));return m?decodeURIComponent(m[1]):null}
  function w(n,v,ms){document.cookie=n+"="+encodeURIComponent(v)+";path=/;max-age="+Math.floor(ms/1e3)+";samesite=lax"}
  function r(){return (Date.now().toString(36)+Math.random().toString(36).slice(2,12)).slice(0,24)}
  var a=c("_hullwise_aid")||r();w("_hullwise_aid",a,Y);
  function sid(){var s=c("_hullwise_sid")||r();w("_hullwise_sid",s,S);return s}
  function send(event,props){var b=JSON.stringify({events:[{event:event,anonymousId:a,sessionId:sid(),url:location.href,referrer:document.referrer||null,ts:Date.now(),props:Object.assign({fbp:c("_fbp"),fbc:c("_fbc")},props||{})}]});
    if(navigator.sendBeacon&&navigator.sendBeacon(U,b))return;fetch(U,{method:"POST",body:b,keepalive:true,headers:{"content-type":"text/plain"}}).catch(function(){})}
  window.hullwise={track:send,identify:function(e){send("identify",{email:e})}};
  send("page_view");
})();`;
}

/** Paste into Shopify admin → Settings → Customer events → Add custom pixel. Event names follow Shopify's Web Pixels API. */
export function shopifyCustomPixel(collectUrl: string): string {
  return `// Hullwise first-party pixel (Shopify custom pixel)
const URL_ = ${JSON.stringify(collectUrl)};
const YEAR = 31536000, HALF_HOUR = 1800;
const rid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).slice(0, 24);
async function ids() {
  let aid = await browser.cookie.get("_hullwise_aid");
  if (!aid) aid = rid();
  await browser.cookie.set("_hullwise_aid=" + aid + "; path=/; max-age=" + YEAR + "; samesite=lax");
  let sid = await browser.cookie.get("_hullwise_sid");
  if (!sid) sid = rid();
  await browser.cookie.set("_hullwise_sid=" + sid + "; path=/; max-age=" + HALF_HOUR + "; samesite=lax");
  return { aid, sid };
}
async function send(event, e, props) {
  const { aid, sid } = await ids();
  const ctx = e.context && e.context.document;
  const body = JSON.stringify({ events: [{ event, anonymousId: aid, sessionId: sid, url: ctx ? ctx.location.href : null, referrer: ctx ? ctx.referrer || null : null, ts: Date.now(),
    props: Object.assign({ fbp: await browser.cookie.get("_fbp"), fbc: await browser.cookie.get("_fbc") }, props || {}) }] });
  fetch(URL_, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain" } });
}
analytics.subscribe("page_viewed", (e) => send("page_view", e));
analytics.subscribe("product_viewed", (e) => send("product_view", e, { productId: e.data.productVariant && e.data.productVariant.product.id }));
analytics.subscribe("product_added_to_cart", (e) => send("add_to_cart", e));
analytics.subscribe("checkout_started", (e) => send("checkout_started", e, { checkoutToken: e.data.checkout.token }));
analytics.subscribe("checkout_completed", (e) => {
  const c = e.data.checkout;
  send("checkout_completed", e, { orderId: c.order && String(c.order.id).split("/").pop(), checkoutToken: c.token, email: c.email, value: c.totalPrice && Number(c.totalPrice.amount), currency: c.currencyCode });
});
`;
}

/** Public collection endpoint of a tenant pixel, on the API host (API_URL, else APP_URL/api). */
export function collectUrlFor(key: string): string {
  return apiEndpoint(`/px/${key}`);
}
