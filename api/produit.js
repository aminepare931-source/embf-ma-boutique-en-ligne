// Vercel Edge Function - génère le HTML avec OG tags pour chaque produit
export const config = { runtime: 'edge' };

const FB_DB = 'https://boutique-embf-default-rtdb.europe-west1.firebasedatabase.app';
const SITE_URL = 'https://embfboutik.vercel.app';

function slugify(t){
  return t.toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9\s-]/g,'')
    .trim().replace(/\s+/g,'-')
    .replace(/-+/g,'-')
    .substring(0,60);
}

export default async function handler(req) {
  const url = new URL(req.url);
  const slug = url.pathname.replace('/produit/', '').replace('/p/', '');
  
  if (!slug || slug === 'produit') {
    return Response.redirect(SITE_URL + '/produits.html', 302);
  }

  try {
    // Fetch all products from Firebase
    const r = await fetch(FB_DB + '/products.json');
    const data = await r.json();
    
    if (!data) {
      return Response.redirect(SITE_URL + '/produit.html', 302);
    }

    // Find product by slug or name
    let product = null;
    let productKey = null;
    for (const [key, p] of Object.entries(data)) {
      if (p.slug === slug || slugify(p.name || '') === slug) {
        product = p;
        productKey = key;
        break;
      }
    }

    if (!product) {
      return Response.redirect(SITE_URL + '/produit.html', 302);
    }

    // Get first image
    let imgUrl = SITE_URL + '/assets/icons/icon-512x512.png';
    try {
      const imgs = JSON.parse(product.images || '[]');
      if (imgs.length > 0) {
        const first = imgs[0];
        imgUrl = typeof first === 'string' ? first : (first.thumbnail || first.url || imgUrl);
      }
    } catch(e) {}

    const title = `${product.name} — ${Number(product.price).toLocaleString('fr-FR')} FCFA | EMBF Boutique`;
    const desc = product.description 
      ? product.description.substring(0, 150) 
      : `Achetez ${product.name} sur EMBF Boutique. Livraison rapide en Afrique de l'Ouest.`;
    const pageUrl = `${SITE_URL}/produit/${product.slug || slug}`;

    // Return HTML with proper OG tags + redirect to produit.html
    const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="EMBF Boutique">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${imgUrl}">
<meta property="og:image:width" content="800">
<meta property="og:image:height" content="800">
<meta property="og:url" content="${pageUrl}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${imgUrl}">
<meta http-equiv="refresh" content="0;url=/produit.html?id=${productKey}">
<script>window.location.replace('/produit.html?id=${productKey}');</script>
</head>
<body>
<p>Chargement...</p>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html;charset=utf-8',
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600'
      }
    });

  } catch(e) {
    return Response.redirect(SITE_URL + '/produit.html', 302);
  }
}
