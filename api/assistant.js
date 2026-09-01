// Vercel Edge Function - Assistant IA pour l'admin EMBF
// Garde la cle Anthropic cote serveur, execute les actions demandees (creer produit, promo...)
export const config = { runtime: 'edge' };

const FB_DB = 'https://boutique-embf-default-rtdb.europe-west1.firebasedatabase.app';
const FB_KEY = 'AIzaSyA0UGFKeoatnMaCMAlaF3B3li9gFY4Dt0g';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-5';

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
    name: 'list_products',
    description: "Liste les produits de la boutique, avec leur ID Firebase, nom, prix, stock, categorie. Utilise ceci avant de modifier ou supprimer un produit dont tu n'as que le nom, pour trouver son ID exact.",
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Filtre optionnel: texte a chercher dans le nom du produit (insensible a la casse). Laisser vide pour tout lister.' }
      }
    }
  },
  {
    name: 'create_product',
    description: "Cree un nouveau produit dans la boutique. Le produit est cree SANS PHOTO (l'assistant ne peut pas fournir de vraies photos) - previens toujours l'utilisateur qu'il doit ajouter des photos depuis l'onglet Produits ensuite.",
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nom du produit' },
        price: { type: 'number', description: 'Prix de vente en FCFA' },
        old_price: { type: 'number', description: "Prix barre avant reduction (optionnel, pour afficher un badge de promo sur ce produit)" },
        category: { type: 'string', enum: ['Ordinateur','Smartphone','Gadget','Accessoires','Autre'], description: 'Categorie du produit' },
        stock: { type: 'number', description: 'Quantite en stock' },
        description: { type: 'string', description: 'Description du produit' },
        specs: { type: 'string', description: 'Caracteristiques techniques, une par ligne' },
        commission: { type: 'number', description: 'Pourcentage de commission affilie (defaut 5 si non precise)' },
        is_new: { type: 'boolean', description: 'Marquer comme nouveaute' },
        trending: { type: 'boolean', description: 'Marquer comme tendance' }
      },
      required: ['name','price']
    }
  },
  {
    name: 'update_product',
    description: "Modifie un produit existant. Utilise list_products d'abord si tu n'as pas l'ID exact. Ne fournis que les champs a changer.",
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'ID Firebase exact du produit (obtenu via list_products)' },
        name: { type: 'string' },
        price: { type: 'number' },
        old_price: { type: 'number' },
        category: { type: 'string', enum: ['Ordinateur','Smartphone','Gadget','Accessoires','Autre'] },
        stock: { type: 'number' },
        description: { type: 'string' },
        specs: { type: 'string' },
        commission: { type: 'number' },
        is_new: { type: 'boolean' },
        trending: { type: 'boolean' }
      },
      required: ['product_id']
    }
  },
  {
    name: 'delete_product',
    description: "Supprime definitivement un produit. Action irreversible - utilise list_products d'abord pour confirmer l'ID exact.",
    input_schema: {
      type: 'object',
      properties: {
        product_id: { type: 'string', description: 'ID Firebase exact du produit' }
      },
      required: ['product_id']
    }
  },
  {
    name: 'set_promo',
    description: "Configure la promotion active du site (bandeau + compte a rebours visible sur la fiche produit concernee, ou sur tous les produits si aucun produit precis n'est cible).",
    input_schema: {
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
  },
  {
    name: 'get_promo',
    description: "Recupere la configuration actuelle de la promotion du site.",
    input_schema: { type: 'object', properties: {} }
  }
];

async function fbFetch(path, opts){
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(FB_DB + path + sep + 'auth=' + FB_KEY, opts);
  if(!r.ok) throw new Error('Firebase error ' + r.status);
  return r.json();
}

async function execTool(name, input){
  if(name === 'list_products'){
    const data = await fbFetch('/products.json');
    if(!data) return { products: [] };
    let list = Object.entries(data).map(([key,p]) => ({
      id: key, name: p.name, price: p.price, old_price: p.old_price || null,
      category: p.category, stock: p.stock
    }));
    if(input.search){
      const s = input.search.toLowerCase();
      list = list.filter(p => (p.name||'').toLowerCase().includes(s));
    }
    return { products: list.slice(0, 60) };
  }

  if(name === 'create_product'){
    const data = {
      name: input.name,
      price: input.price,
      slug: slugify(input.name),
      old_price: input.old_price || null,
      category: input.category || 'Autre',
      stock: input.stock != null ? input.stock : 0,
      description: input.description || '',
      specs: input.specs || '',
      commission: input.commission != null ? input.commission : 5,
      images: '[]',
      is_new: !!input.is_new,
      trending: !!input.trending,
      createdAt: Date.now()
    };
    const res = await fbFetch('/products.json', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    return { success: true, product_id: res.name, note: 'Produit cree sans photo - a ajouter manuellement dans Produits.' };
  }

  if(name === 'update_product'){
    const { product_id, ...fields } = input;
    if(!product_id) throw new Error('product_id manquant');
    const patch = {};
    for(const k of ['name','price','old_price','category','stock','description','specs','commission','is_new','trending']){
      if(fields[k] !== undefined) patch[k] = fields[k];
    }
    if(patch.name) patch.slug = slugify(patch.name);
    await fbFetch('/products/' + product_id + '.json', { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(patch) });
    return { success: true };
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
  if(!ANTHROPIC_API_KEY){
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY non configuree sur Vercel" }), { status: 500 });
  }

  let body;
  try{ body = await req.json(); } catch(e){
    return new Response(JSON.stringify({ error: 'JSON invalide' }), { status: 400 });
  }

  const history = Array.isArray(body.history) ? body.history : [];
  const userMessage = body.message || '';
  if(!userMessage.trim()){
    return new Response(JSON.stringify({ error: 'Message vide' }), { status: 400 });
  }

  const messages = [...history, { role: 'user', content: userMessage }];
  const actionsLog = [];
  const SYSTEM = `Tu es l'assistante IA de gestion de EMBF Boutique (Electro Market BF), une boutique en ligne au Burkina Faso. Tu aides l'administrateur a gerer sa boutique: creer/modifier/supprimer des produits, configurer des promotions. Sois concise, parle en francais, confirme toujours clairement ce que tu as fait a la fin. Si une demande est ambigue (prix, categorie manquants), demande une precision au lieu de deviner. N'invente jamais d'ID de produit - utilise toujours list_products pour les retrouver.`;

  try{
    for(let iter = 0; iter < 6; iter++){
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1500,
          system: SYSTEM,
          tools: TOOLS,
          messages: messages
        })
      });

      if(!resp.ok){
        const errText = await resp.text();
        return new Response(JSON.stringify({ error: 'Erreur API Anthropic: ' + errText }), { status: 502 });
      }

      const data = await resp.json();
      messages.push({ role: 'assistant', content: data.content });

      const toolUses = data.content.filter(b => b.type === 'tool_use');
      if(toolUses.length === 0){
        const finalText = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        return new Response(JSON.stringify({ reply: finalText, actions: actionsLog, history: messages }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }

      const toolResults = [];
      for(const tu of toolUses){
        try{
          const result = await execTool(tu.name, tu.input || {});
          actionsLog.push({ tool: tu.name, input: tu.input, result });
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
        }catch(e){
          actionsLog.push({ tool: tu.name, input: tu.input, error: e.message });
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Erreur: ' + e.message, is_error: true });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    }

    return new Response(JSON.stringify({ reply: "Trop d'etapes necessaires, reformule ta demande plus simplement.", actions: actionsLog, history: messages }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
