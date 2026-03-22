interface ProxyInfo {
  url: string;
  latency: string;
  country: string;
}

let workingProxies: ProxyInfo[] = [];

async function checkProxy(proxyAddr: string): Promise<ProxyInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  const startTime = performance.now(); // စတင်ချိန်

  try {
    const client = Deno.createHttpClient({ proxy: { url: proxyAddr } });
    
    // IP နှင့် နိုင်ငံကို သိနိုင်ရန် IP-API ကို အသုံးပြုခြင်း
    const res = await fetch("http://ip-api.com/json/?fields=status,countryCode", {
      client,
      signal: controller.signal,
    });
    
    const endTime = performance.now(); // ပြီးဆုံးချိန်
    const latency = Math.round(endTime - startTime); // Latency တွက်ချက်ခြင်း

    if (res.ok) {
      const geoData = await res.json();
      client.close();
      
      if (geoData.status === "success") {
        return {
          url: proxyAddr,
          latency: `${latency}ms`,
          country: geoData.countryCode
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
  console.log("🔄 Proxy အသစ်များ စစ်ဆေးနေသည်...");
  const res = await fetch("https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt");
  const text = await res.text();
  const raw = text.split("\n").map(p => `http://${p.trim()}`).filter(p => p.length > 10).slice(0, 30); // Speed အတွက် ၃၀ ခုပဲ အရင်စစ်မယ်

  const results = await Promise.all(raw.map(checkProxy));
  workingProxies = results.filter((p): p is ProxyInfo => p !== null);
  console.log(`✅ အလုပ်လုပ်သော Proxy ${workingProxies.length} ခု ရှာဖွေတွေ့ရှိပါသည်။`);
}

// ၁၅ မိနစ်တစ်ခါ အသစ်ယူ၊ ၅ မိနစ်တစ်ခါ ရှိတာကို ပြန်စစ်
refreshPool();
setInterval(refreshPool, 15 * 60 * 1000);

Deno.serve({ port: 8000 }, (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  return new Response(JSON.stringify(workingProxies), { headers });
});
