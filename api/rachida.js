// Vercel Edge Function - Rachida, assistante d'achat cote client
// Peut chercher des produits, repondre sur les politiques du site, et PRENDRE une commande
// (creation seule dans /orders - jamais de modification/suppression de donnees existantes)
export const config = { runtime: 'edge' };

const FB_DB = 'https://boutique-embf-default-rtdb.europe-west1.firebasedatabase.app';
const FB_KEY = 'AIzaSyA0UGFKeoatnMaCMAlaF3B3li9gFY4Dt0g';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

const PROVIDERS = [
  { name: 'groq-gptoss120b', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: 'openai/gpt-oss-120b' },
  { name: 'groq-llama70b', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: 'llama-3.3-70b-versatile' },
  { name: 'groq-gptoss20b', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: 'openai/gpt-oss-20b' },
  { name: 'groq-llama8b', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: 'llama-3.1-8b-instant' },
  { name: 'nvidia', url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: NVIDIA_API_KEY, model: 'meta/llama-3.3-70b-instruct' }
].filter(p => !!p.key);

async function tryAllProviders(messages, tools){
  let lastErr = null;
  for(const provider of PROVIDERS){
    try{
      const resp = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.key },
        body: JSON.stringify({ model: provider.model, messages, tools, tool_choice: 'auto', max_tokens: 900 })
      });
      if(!resp.ok){ lastErr = provider.name + ' (HTTP ' + resp.status + '): ' + (await resp.text()).slice(0,300); continue; }
      const data = await resp.json();
      const choice = data.choices && data.choices[0];
      if(!choice){ lastErr = provider.name + ': reponse vide'; continue; }
      return { message: choice.message };
    }catch(e){ lastErr = provider.name + ': ' + e.message; }
  }
  return { error: lastErr || 'aucun fournisseur configure' };
}
async function callLLM(messages, tools){
  let result = await tryAllProviders(messages, tools);
  if(result.message) return result.message;
  // Tous les fournisseurs ont echoue - probablement une saturation passagere, on reessaie une fois
  await new Promise(r => setTimeout(r, 800));
  result = await tryAllProviders(messages, tools);
  if(result.message) return result.message;
  throw new Error('IA indisponible apres 2 tentatives - ' + result.error);
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description: "Cherche des produits dans la boutique par nom, categorie ou mots-cles. A UTILISER IMMEDIATEMENT des qu'un client mentionne un produit, une categorie, un budget, ou une idee de cadeau meme vague - ne demande jamais la ville, le paiement ou d'autres details avant d'avoir cherche et montre des resultats. Aussi utilise avant de prendre une commande (pour confirmer le prix exact et la disponibilite).",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Mots-cles de recherche (nom du produit ou categorie)' },
          category: { type: 'string', enum: ['Smartphones','Ordinateurs','Accessoires','Gadgets','Audio','Montres','Autre'], description: 'Filtrer par categorie (optionnel)' },
          availability: { type: 'string', enum: ['stock','commande'], description: 'Filtrer par disponibilite (optionnel)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_promo',
      description: "Verifie s'il y a une promotion active en ce moment sur la boutique.",
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_order',
      description: "Enregistre une commande dans le systeme de la boutique, qui apparaitra immediatement dans l'admin pour traitement. N'appelle CET OUTIL QU'UNE FOIS que tu as recapitule la commande complete au client (produit, quantite, prix, adresse, moyen de paiement) et qu'il a confirme. Utilise search_products juste avant pour verifier le prix exact et l'ID du produit.",
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'string', description: 'ID Firebase exact du produit (obtenu via search_products)' },
          product_name: { type: 'string', description: 'Nom du produit (pour le recap)' },
          price: { type: 'number', description: 'Prix unitaire exact (obtenu via search_products)' },
          quantity: { type: 'number', description: 'Quantite commandee' },
          customer_name: { type: 'string', description: 'Nom complet du client' },
          phone: { type: 'string', description: 'Numero de telephone du client' },
          country: { type: 'string', description: 'Pays de livraison' },
          city: { type: 'string', description: 'Ville de livraison' },
          neighborhood: { type: 'string', description: 'Quartier (optionnel)' },
          customer_type: { type: 'string', enum: ['Particulier','Commerçant'], description: "Type de client" },
          payment_method: { type: 'string', description: "Moyen de paiement choisi: Orange Money, Moov Money, Wave, Virement bancaire, ou Especes (Bobo-Dioulasso uniquement)" },
          note: { type: 'string', description: 'Note ou precision supplementaire du client (optionnel)' }
        },
        required: ['product_id','product_name','price','quantity','customer_name','phone','country','city','payment_method']
      }
    }
  }
];

function normalizeText(s){
  return (s||'').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
}
const CATEGORY_SYNONYMS = {
  'audio': ['ecouteur','ecouteurs','casque','casques','airpods','airpod','enceinte','enceintes','haut-parleur','hautparleur','bluetooth','oreillette','oreillettes','earbuds','headphone','headphones','micro','microphone','wireless','sans fil'],
  'smartphones': ['telephone','telephones','smartphone','smartphones','portable','iphone','samsung','android','gsm'],
  'ordinateurs': ['ordinateur','ordinateurs','laptop','pc','notebook','portable'],
  'montres': ['montre','montres','smartwatch','watch','connectee'],
  'gadgets': ['gadget','gadgets']
};

async function execTool(name, input){
  if(name === 'search_products'){
    const r = await fetch(FB_DB + '/products.json');
    const data = await r.json();
    if(!data) return { products: [] };
    let list = Object.entries(data).map(([key,p]) => {
      const searchText = normalizeText([p.name, p.category, p.description, p.specs].filter(Boolean).join(' '));
      return {
        id: key, name: p.name, price: p.price, old_price: p.old_price || null,
        category: p.category, availability: p.availability || 'stock',
        delayDays: p.delayDays || null, stock: p.stock,
        url: 'https://embfboutik.vercel.app/produit/' + (p.slug || key),
        _search: searchText
      };
    });
    if(input.category) list = list.filter(p => p.category === input.category);
    if(input.availability) list = list.filter(p => p.availability === input.availability);
    if(input.query){
      const q = normalizeText(input.query);
      const matchedCatWords = [];
      for(const syns of Object.values(CATEGORY_SYNONYMS)){
        if(syns.some(s => q.includes(normalizeText(s)))) matchedCatWords.push(...syns);
      }
      const words = q.split(/\s+/).filter(w => w.length >= 3).concat(matchedCatWords.map(normalizeText));
      list = list.filter(p => words.some(w => p._search.includes(w)));
    }
    list = list.map(({_search, ...rest}) => rest);
    return { products: list.slice(0, 15) };
  }
  if(name === 'get_promo'){
    const r = await fetch(FB_DB + '/promo.json');
    const data = await r.json();
    return data || { active: false };
  }
  if(name === 'create_order'){
    const required = ['product_id','product_name','price','quantity','customer_name','phone','country','city','payment_method'];
    for(const k of required){
      if(input[k] === undefined || input[k] === null || input[k] === ''){
        throw new Error('Champ manquant: ' + k);
      }
    }
    const orderData = {
      produit: input.product_name,
      produitId: input.product_id,
      prix: input.price,
      quantite: input.quantity,
      client: {
        nom: input.customer_name,
        tel: input.phone,
        pays: input.country,
        ville: input.city,
        quartier: input.neighborhood || '',
        type: input.customer_type === 'Commerçant' ? 'Commerçant' : 'Particulier'
      },
      paiement: input.payment_method,
      message: (input.note || '') + ' [Commande prise par Rachida]',
      ref: null,
      statut: 'nouveau',
      ts: Date.now()
    };
    const r = await fetch(FB_DB + '/orders.json?auth=' + FB_KEY, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(orderData)
    });
    if(!r.ok) throw new Error('Erreur enregistrement commande');
    const res = await r.json();
    return { success: true, order_id: res.name, total: input.price * input.quantity };
  }
  throw new Error('Outil inconnu: ' + name);
}

export default async function handler(req){
  if(req.method !== 'POST'){
    return new Response(JSON.stringify({ error: 'Methode non supportee' }), { status: 405 });
  }
  if(PROVIDERS.length===0){
    return new Response(JSON.stringify({ error: "Aucune cle IA configuree" }), { status: 500 });
  }

  let body;
  try{ body = await req.json(); }catch(e){
    return new Response(JSON.stringify({ error: 'JSON invalide' }), { status: 400 });
  }

  const history = Array.isArray(body.history) ? body.history : [];
  const userMessage = body.message || '';
  if(!userMessage.trim()){
    return new Response(JSON.stringify({ error: 'Message vide' }), { status: 400 });
  }

  const SYSTEM = `Tu es Rachida, l'assistante de EMBF Boutique (Electro Market BF), boutique en ligne d'equipement electronique et divers a Bobo-Dioulasso, Burkina Faso.

TON ET STYLE
Tu es professionnelle et tres accueillante, comme une vraie conseillere de vente chaleureuse qui connait bien la maison - pas un robot. Parle simplement, avec des phrases naturelles. N'utilise pas d'emojis de maniere systematique ou decorative - seulement si ca vient vraiment naturellement, avec parcimonie. Tutoiement ou vouvoiement selon comment le client s'adresse a toi. Sois concise: des reponses utiles, pas des pavés.

FORMAT DE REPONSE - TRES IMPORTANT
Tes messages s'affichent en texte brut simple, sans mise en forme. N'utilise JAMAIS de Markdown: pas de tableaux (pas de |, pas de ---), pas d'asterisques pour le gras (**texte**), pas de liens entre chevrons (<https://...>), pas de dieses pour les titres (#). Ecris comme si tu envoyais un message WhatsApp normal: des phrases completes, des retours a la ligne simples, et pour lister plusieurs produits utilise des tirets simples, un produit par ligne, avec le prix et la disponibilite ecrits dans la phrase. Si tu donnes un lien, ecris l'URL brute directement dans le texte (sans chevrons ni crochets) pour qu'elle reste cliquable telle quelle.

CE QUE TU CONNAIS (utilise ces informations reelles, n'en invente jamais d'autres)
- Livraison: Bobo-Dioulasso 24H, Ouagadougou 24-48H, autres villes du Burkina Faso 48-72H, Afrique de l'Ouest (Côte d'Ivoire, Sénégal, Mali) 3-7 jours. Ces delais s'appliquent aux produits deja en stock. Les produits "sur commande" (import) prennent 10-20 jours - verifie toujours via search_products si un produit est en stock ou sur commande avant d'annoncer un delai.
- Paiement: Orange Money, Moov Money, Wave, virement bancaire, ou especes (uniquement a Bobo-Dioulasso). Paiement integral requis avant expedition.
- Retours: produit defectueux -> contact sous 48h avec photos via WhatsApp, echange ou remboursement selon le cas. Retractation possible sous 7 jours apres reception si le produit est non utilise et dans son emballage d'origine (frais de retour a la charge de l'acheteur).
- Garantie: tous les produits sont 100% authentiques, garantie constructeur de 6 a 12 mois selon le produit (ne couvre pas la mauvaise utilisation).
- Contact humain: WhatsApp +226 55 30 08 68, email aminepare931@gmail.com, disponible 7j/7 de 8h a 22h.
- Donnees personnelles: utilisees uniquement pour traiter et livrer la commande, jamais vendues a des tiers.

RECHERCHE DE PRODUITS - REGLE ABSOLUE
Des qu'un client mentionne un produit, une categorie, une idee de cadeau, un budget, ou demande "montrez-moi", "proposez-moi", "vous avez quoi", "les moins chers", "vous avez des X", etc., appelle IMMEDIATEMENT search_products et presente de vrais resultats. N'attends JAMAIS d'avoir la ville, le quartier, le mode de paiement ou d'autres details de commande avant de faire une recherche et de montrer des produits - ces informations ne servent qu'au moment de create_order, jamais avant. Tu as le droit de poser UNE question si la demande est vraiment trop vague pour chercher quoi que ce soit (par exemple "un cadeau" sans aucune indication), mais une seule question maximum, et seulement si search_products avec les infos deja donnees ne suffirait vraiment pas. Si le client a deja donne une categorie meme approximative (ex: "une montre", "des ecouteurs", "un telephone"), cherche DIRECTEMENT sur cette categorie et montre les resultats reels - ne demande jamais le type precis ou le budget avant de chercher, la liste de resultats montrera naturellement la variete de types et de prix disponibles, et le client choisira parmi de vraies options. Ne jamais poser deux fois de suite des questions sans avoir d'abord essaye de chercher: mieux vaut montrer plusieurs options reelles que de faire attendre le client avec des questions.

Exemple de bon comportement:
Client: "vous avez des ecouteurs ?"
Toi: [appelle immediatement search_products avec category="Audio" ou query="ecouteur"] puis presente les modeles trouves avec leurs prix, sans avoir rien demande avant.

Exemple de mauvais comportement (a ne JAMAIS faire):
Client: "vous avez des ecouteurs ?"
Toi: "Pourriez-vous preciser le type (in-ear, sans fil...) et votre budget ?" <- INTERDIT, cherche d'abord.

CE QUE TU PEUX FAIRE
Tu peux regler la quasi-totalite d'une demande client directement dans ce chat: trouver un produit, comparer des prix, expliquer la livraison/le paiement/les retours/la garantie, et surtout PRENDRE LA COMMANDE toi-meme. Pour prendre une commande (uniquement une fois que le client a choisi un produit precis et veut commander): recueille le produit exact (deja verifie via search_products), la quantite, le nom complet, le telephone, le pays, la ville, le quartier (si connu), le type de client (particulier ou commercant), et le moyen de paiement souhaite - dans cet ordre, une fois que la decision d'achat est prise, jamais avant. Recapitule TOUJOURS la commande complete au client avant de l'enregistrer (produit, quantite, prix total, adresse, paiement) et attends sa confirmation explicite avant d'appeler create_order. Une fois enregistree, confirme-lui que sa commande est bien recue et qu'elle sera traitee, et rappelle qu'on peut le recontacter via le telephone donne.

CE QUE TU NE FAIS PAS
Tu ne peux pas modifier ou annuler une commande deja enregistree (ni par toi ni par quelqu'un d'autre), ni traiter un paiement toi-meme (le client paie apres confirmation, selon le mode choisi), ni negocier les prix. Pour toute question sur une commande deja passee ou tout probleme apres-vente, oriente vers WhatsApp. Ne reponds pas a des questions hors du cadre de la boutique.`;

  let messages = history.length ? history : [{ role: 'system', content: SYSTEM }];
  messages.push({ role: 'user', content: userMessage });

  try{
    for(let iter = 0; iter < 6; iter++){
      let msg;
      try{ msg = await callLLM(messages, TOOLS); }
      catch(e){ return new Response(JSON.stringify({ error: e.message }), { status: 502 }); }
      messages.push(msg);

      const toolCalls = msg.tool_calls || [];
      if(toolCalls.length === 0){
        return new Response(JSON.stringify({ reply: msg.content || '', history: messages }), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }

      for(const tc of toolCalls){
        let input = {};
        try{ input = JSON.parse(tc.function.arguments || '{}'); }catch(e){}
        try{
          const result = await execTool(tc.function.name, input);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }catch(e){
          messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Erreur: ' + e.message });
        }
      }
    }
    return new Response(JSON.stringify({ reply: "Peux-tu reformuler ta question ?", history: messages }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }catch(e){
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}

