interface ProxyInfo {
  url: string;
  latency: string;
  country: string;
}

// Global pool of working proxies
let workingProxies: ProxyInfo[] = [];
let isInitialLoading = true;

async function checkProxy(proxyAddr: string): Promise<ProxyInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000); 
  const startTime = performance.now();

  try {
    // Note: In Deno 2.0+, use the 'proxy' property directly in fetch
    const res = await fetch("http://ip-api.com/json/?fields=status,countryCode", {
      // @ts-ignore: Deno specific proxy property
      proxy: { url: proxyAddr },
      signal: controller.signal,
    });
    
    const endTime = performance.now();
    const latency = Math.round(endTime - startTime);

    if (res.ok) {
      const geoData = await res.json();
      if (geoData.status === "success") {
        return {
          url: proxyAddr,
          latency: `${latency}ms`,
          country: geoData.countryCode || "??"
        };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshPool() {
  console.log("🔄 Fetching fresh proxy list...");
  try {
    // Using the SOCKS5 list as the source
    const res = await fetch("https://raw.githubusercontent.com/r00tee/Proxy-List/refs/heads/main/Socks5.txt");
    const text = await res.text();
    
    // Convert IP:PORT format to socks5://IP:PORT
    const raw = text.split("\n")
      .map(p => p.trim())
      .filter(p => p.length > 5)
      .map(p => p.includes("://") ? p : `socks5://${p}`)
      .slice(0, 150); 

    console.log(`📡 Testing ${raw.length} candidates...`);

    const results: ProxyInfo[] = [];
    const chunkSize = 25;
    
    for (let i = 0; i < raw.length; i += chunkSize) {
      const chunk = raw.slice(i, i + chunkSize);
      const chunkResults = await Promise.all(chunk.map(checkProxy));
      const validOnes = chunkResults.filter((p): p is ProxyInfo => p !== null);
      results.push(...validOnes);
      console.log(`| Checked: ${Math.min(i + chunkSize, raw.length)}/${raw.length} | Found: ${results.length}`);
    }

    if (results.length > 0) {
      workingProxies = results.sort((a, b) => parseInt(a.latency) - parseInt(b.latency));
      console.log(`✅ Success! Found ${workingProxies.length} working proxies.`);
    } else {
      console.log("⚠️ No working proxies found. Keeping previous list.");
    }
  } catch (err) {
    console.error("❌ Error refreshing pool:", err);
  } finally {
    isInitialLoading = false;
  }
}

// Initial fetch
refreshPool();

// Refresh every 10 minutes
setInterval(refreshPool, 10 * 60 * 1000);

Deno.serve({ port: 8000 }, (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (isInitialLoading && workingProxies.length === 0) {
    return new Response(JSON.stringify([{ url: "loading...", latency: "0ms", country: ".." }]), { headers });
  }

  return new Response(JSON.stringify(workingProxies, null, 2), { headers });
});
