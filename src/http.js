const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch med omförsök vid 429 och 5xx.
export async function request(url, opts = {}, tries = 5) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, opts);
    if (res.ok) return res.status === 204 ? null : res.json();
    if ((res.status === 429 || res.status >= 500) && i < tries - 1) {
      await sleep(1000 * 2 ** i);
      continue;
    }
    const body = await res.text();
    throw new Error(`${opts.method ?? 'GET'} ${url} -> ${res.status}: ${body.slice(0, 500)}`);
  }
}
