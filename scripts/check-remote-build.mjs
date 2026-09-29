async function main() {
  const res = await fetch('https://puntoencuentro.com.ar/preview/home-gsap');
  const html = await res.text();
  console.log('Status:', res.status);
  const assets = html.match(/\/assets\/[a-zA-Z0-9_\-\.]+\.js/g) || [];
  console.log('Found JS assets:', assets);
  for (const asset of assets) {
    const assetUrl = 'https://puntoencuentro.com.ar' + asset;
    const jsText = await (await fetch(assetUrl)).text();
    if (jsText.includes('02:16:46')) {
      console.log('FOUND 02:16:46 IN:', assetUrl);
      const idx = jsText.indexOf('02:16:46');
      console.log('Surrounding text:', jsText.substring(Math.max(0, idx - 80), idx + 80));
    }
  }
}
main().catch(console.error);
