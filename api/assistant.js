// Vercel Edge Function - Assistant IA pour l'admin EMBF (via Groq)
// Garde la cle Groq cote serveur, execute les actions demandees (creer produit, promo...)
export const config = { runtime: 'edge' };

const FB_DB = 'https://boutique-embf-default-rtdb.europe-west1.firebasedatabase.app';
const FB_KEY = 'AIzaSyA0UGFKeoatnMaCMAlaF3B3li9gFY4Dt0g';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = 'openai/gpt-oss-120b';

function slugify(t){
  return t.toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9\s-]/g,'')
    .trim().replace(/\s+/g,'-')
    .replace(/-+/g,'-')
    .substring(0,60);
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_products',
      description: "Liste les produits de la boutique, avec leur ID Firebase, nom, prix, stock, categorie, disponibilite. Utilise ceci avant de modifier ou supprimer un produit dont tu n'as que le nom, pour trouver son ID exact.",
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Filtre optionnel: texte a chercher dans le nom du produit (insensible a la casse). Laisser vide pour tout lister.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_product',
      description: "Cree un nouveau produit dans la boutique. Si l'utilisateur a joint des photos/videos a son message, elles seront automatiquement rattachees au produit cree - ne demande jamais a l'utilisateur de fournir des images toi-meme, tu ne peux pas en generer ni en trouver. IMPORTANT: demande toujours si le produit est en stock (livraison rapide) ou sur commande (10-20 jours, generalement moins cher) si ce n'est pas precise.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nom du produit' },
          price: { type: 'number', description: 'Prix de vente en FCFA' },
          old_price: { type: 'number', description: "Prix barre avant reduction (optionnel, pour afficher un badge de promo sur ce produit)" },
          category: { type: 'string', enum: ['Smartphones','Ordinateurs','Accessoires','Gadgets','Audio','Montres','Autre'], description: 'Categorie du produit' },
          stock: { type: 'number', description: 'Quantite en stock (uniquement si availability=stock)' },
          availability: { type: 'string', enum: ['stock','commande'], description: "'stock' = produit disponible immediatement, livraison rapide 24-72H. 'commande' = produit importe sur commande, delai 10 a 20 jours, generalement prix plus avantageux." },
          delay_days: { type: 'string', description: "Delai de livraison affiche pour un produit sur commande, ex: '10-20 jours'. Ignorer si availability=stock." },
          description: { type: 'string', description: 'Description du produit' },
          specs: { type: 'string', description: 'Caracteristiques techniques, une par ligne' },
          commission: { type: 'number', description: 'Pourcentage de commission affilie (defaut 5 si non precise)' },
          is_new: { type: 'boolean', description: 'Marquer comme nouveaute' },
          trending: { type: 'boolean', description: 'Marquer comme tendance' }
        },
        required: ['name','price','availability']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_product',
      description: "Modifie un produit existant. Utilise list_products d'abord si tu n'as pas l'ID exact. Ne fournis que les champs a changer. Si l'utilisateur a joint des photos/videos a son message, elles seront automatiquement ajoutees a ce produit.",
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'string', description: 'ID Firebase exact du produit (obtenu via list_products)' },
          name: { type: 'string' },
          price: { type: 'number' },
          old_price: { type: 'number' },
          category: { type: 'string', enum: ['Smartphones','Ordinateurs','Accessoires','Gadgets','Audio','Montres','Autre'] },
          stock: { type: 'number' },
          availability: { type: 'string', enum: ['stock','commande'] },
          delay_days: { type: 'string' },
          description: { type: 'string' },
          specs: { type: 'string' },
          commission: { type: 'number' },
          is_new: { type: 'boolean' },
          trending: { type: 'boolean' }
        },
        required: ['product_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_product',
      description: "Supprime definitivement un produit. Action irreversible - utilise list_products d'abord pour confirmer l'ID exact.",
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'string', description: 'ID Firebase exact du produit' }
        },
        required: ['product_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_promo',
      description: "Configure la promotion active du site (bandeau + compte a rebours visible sur la fiche produit concernee, ou sur tous les produits si aucun produit precis n'est cible).",
      parameters: {
        type: 'object',
        properties: {
          active: { type: 'boolean', description: 'Activer ou desactiver la promo' },
          featured_product_id: { type: 'string', description: "ID Firebase du produit concerne par la promo (optionnel - si absent, s'applique a toutes les fiches produit)" },
          message: { type: 'string', description: "Message affiche, ex: 'Offre limitee !'" },
          discount_percent: { type: 'number', description: 'Pourcentage de reduction' },
          end_date: { type: 'string', description: "Date/heure de fin au format ISO 8601, ex: 2026-09-10T23:59:00. Obligatoire si active=true." }
        },
        required: ['active']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_promo',
      description: "Recupere la configuration actuelle de la promotion du site.",
      parameters: { type: 'object', properties: {} }
    }
  }
];

async function fbFetch(path, opts){
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(FB_DB + path + sep + 'auth=' + FB_KEY, opts);
  if(!r.ok) throw new Error('Firebase error ' + r.status);
  return r.json();
}

async function execTool(name, input, pendingMedia){
  if(name === 'list_products'){
    const data = await fbFetch('/products.json');
    if(!data) return { products: [] };
    let list = Object.entries(data).map(([key,p]) => ({
      id: key, name: p.name, price: p.price, old_price: p.old_price || null,
      category: p.category, stock: p.stock, availability: p.availability || 'stock'
    }));
    if(input.search){
      const s = input.search.toLowerCase();
      list = list.filter(p => (p.name||'').toLowerCase().includes(s));
    }
    return { products: list.slice(0, 60) };
  }

  if(name === 'create_product'){
    const avail = input.availability === 'commande' ? 'commande' : 'stock';
    const media = (pendingMedia && pendingMedia.length) ? pendingMedia : [];
    const data = {
      name: input.name,
      price: input.price,
      slug: slugify(input.name),
      old_price: input.old_price || null,
      category: input.category || 'Autre',
      stock: avail === 'stock' ? (input.stock != null ? input.stock : 0) : 0,
      availability: avail,
      delayDays: avail === 'commande' ? (input.delay_days || '10-20 jours') : null,
      description: input.description || '',
      specs: input.specs || '',
      commission: input.commission != null ? input.commission : 5,
      images: JSON.stringify(media),
      is_new: !!input.is_new,
      trending: !!input.trending,
      createdAt: Date.now()
    };
    const res = await fbFetch('/products.json', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    return { success: true, product_id: res.name, photos_attached: media.length, note: media.length ? undefined : 'Produit cree sans photo - a ajouter manuellement dans Produits.' };
  }

  if(name === 'update_product'){
    const { product_id, ...fields } = input;
    if(!product_id) throw new Error('product_id manquant');
    const patch = {};
    for(const k of ['name','price','old_price','category','stock','description','specs','commission','is_new','trending']){
      if(fields[k] !== undefined) patch[k] = fields[k];
    }
    if(fields.availability !== undefined){
      patch.availability = fields.availability === 'commande' ? 'commande' : 'stock';
      if(fields.availability === 'commande'){
        patch.delayDays = fields.delay_days || '10-20 jours';
      } else {
        patch.delayDays = null;
      }
    } else if(fields.delay_days !== undefined){
      patch.delayDays = fields.delay_days;
    }
    if(patch.name) patch.slug = slugify(patch.name);
    let photosAttached = 0;
    if(pendingMedia && pendingMedia.length){
      const current = await fbFetch('/products/' + product_id + '/images.json');
      let existing = [];
      try{ existing = current ? JSON.parse(current) : []; }catch(e){ existing = []; }
      patch.images = JSON.stringify(existing.concat(pendingMedia));
      photosAttached = pendingMedia.length;
    }
    await fbFetch('/products/' + product_id + '.json', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(patch) });
    return { success: true, photos_attached: photosAttached };
  }

  if(name === 'delete_product'){
    if(!input.product_id) throw new Error('product_id manquant');
    await fbFetch('/products/' + input.product_id + '.json', { method: 'DELETE' });
    return { success: true };
  }

  if(name === 'set_promo'){
    const data = {
      active: !!input.active,
      featuredProductId: input.featured_product_id || null,
      message: input.message || null,
      discountPercent: input.discount_percent != null ? input.discount_percent : null,
      endDate: input.end_date ? new Date(input.end_date).toISOString() : null,
      updatedAt: Date.now()
    };
    await fbFetch('/promo.json', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    return { success: true };
  }

  if(name === 'get_promo'){
    const data = await fbFetch('/promo.json');
    return data || { active: false };
  }

  throw new Error('Outil inconnu: ' + name);
}

export default async function handler(req){
  if(req.method !== 'POST'){
    return new Response(JSON.stringify({ error: 'Methode non supportee' }), { status: 405 });
  }
  if(!GROQ_API_KEY){
    return new Response(JSON.stringify({ error: "GROQ_API_KEY non configuree sur Vercel" }), { status: 500 });
  }

  let body;
  try{ body = await req.json(); } catch(e){
    return new Response(JSON.stringify({ error: 'JSON invalide' }), { status: 400 });
  }

  const history = Array.isArray(body.history) ? body.history : [];
  const userMessage = body.message || '';
  const attachments = Array.isArray(body.attachments) ? body.attachments.filter(a => a && a.url) : [];
  if(!userMessage.trim()){
    return new Response(JSON.stringify({ error: 'Message vide' }), { status: 400 });
  }

  const SYSTEM = `Tu es l'assistante IA de gestion de EMBF Boutique (Electro Market BF), une boutique en ligne au Burkina Faso. Tu aides l'administrateur a gerer sa boutique: creer/modifier/supprimer des produits, configurer des promotions. La boutique vend des produits de deux facons: "stock" (disponible immediatement, livraison rapide 24-72H) et "commande" (importe sur commande, delai 10-20 jours, generalement moins cher). Demande toujours laquelle des deux si l'utilisateur ne le precise pas en creant un produit. Sois concise, parle en francais, confirme toujours clairement ce que tu as fait a la fin. Si une demande est ambigue (prix, categorie manquants), demande une precision au lieu de deviner. N'invente jamais d'ID de produit - utilise toujours list_products pour les retrouver.`;

  let messages = history.length ? history : [{ role: 'system', content: SYSTEM }];
  let userContent = userMessage;
  if(attachments.length){
    userContent += `\n\n[${attachments.length} photo(s)/video(s) joint(e)s a ce message - elles seront automatiquement rattachees au produit que tu vas creer ou modifier, tu n'as rien a faire de plus a ce sujet]`;
  }
  messages.push({ role: 'user', content: userContent });
  const actionsLog = [];
  let mediaAvailable = attachments;

  try{
    for(let iter = 0; iter < 6; iter++){
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + GROQ_API_KEY
        },
        body: JSON.stringify({
          model: MODEL,
          messages: messages,
          tools: TOOLS,
          tool_choice: 'auto',
          max_completion_tokens: 1500
        })
      });

      if(!resp.ok){
        const errText = await resp.text();
        return new Response(JSON.stringify({ error: 'Erreur API Groq: ' + errText }), { status: 502 });
      }

      const data = await resp.json();
      const choice = data.choices && data.choices[0];
      if(!choice){
        return new Response(JSON.stringify({ error: 'Reponse Groq vide' }), { status: 502 });
      }
      const msg = choice.message;
      messages.push(msg);

      const toolCalls = msg.tool_calls || [];
      if(toolCalls.length === 0){
        return new Response(JSON.stringify({ reply: msg.content || '', actions: actionsLog, history: messages }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }

      for(const tc of toolCalls){
        let input = {};
        try{ input = JSON.parse(tc.function.arguments || '{}'); }catch(e){}
        try{
          const useMedia = (tc.function.name === 'create_product' || tc.function.name === 'update_product') ? mediaAvailable : [];
          const result = await execTool(tc.function.name, input, useMedia);
          if(useMedia.length) mediaAvailable = [];
          actionsLog.push({ tool: tc.function.name, input: input, result: result });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }catch(e){
          actionsLog.push({ tool: tc.function.name, input: input, error: e.message });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Erreur: ' + e.message });
        }
      }
    }

    return new Response(JSON.stringify({ reply: "Trop d'etapes necessaires, reformule ta demande plus simplement.", actions: actionsLog, history: messages }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
