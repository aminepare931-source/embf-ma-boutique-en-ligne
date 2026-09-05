// Vercel Edge Function - Rachida, assistante d'achat cote client (LECTURE SEULE)
// Aucune capacite de creation/modification/suppression - uniquement pour aider les visiteurs
export const config = { runtime: 'edge' };

const FB_DB = 'https://boutique-embf-default-rtdb.europe-west1.firebasedatabase.app';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

const PROVIDERS = [
  { name: 'groq-gptoss120b', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: 'openai/gpt-oss-120b' },
  { name: 'groq-llama70b', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: 'llama-3.3-70b-versatile' },
  { name: 'groq-gptoss20b', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: 'openai/gpt-oss-20b' },
  { name: 'groq-llama8b', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_API_KEY, model: 'llama-3.1-8b-instant' },
  { name: 'nvidia', url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: NVIDIA_API_KEY, model: 'meta/llama-3.3-70b-instruct' }
].filter(p => !!p.key);

async function callLLM(messages, tools){
  let lastErr = null;
  for(const provider of PROVIDERS){
    try{
      const resp = await fetch(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + provider.key },
        body: JSON.stringify({ model: provider.model, messages, tools, tool_choice: 'auto', max_tokens: 800 })
      });
      if(!resp.ok){ lastErr = provider.name + ': ' + await resp.text(); continue; }
      const data = await resp.json();
      const choice = data.choices && data.choices[0];
      if(!choice){ lastErr = provider.name + ': reponse vide'; continue; }
      return choice.message;
    }catch(e){ lastErr = provider.name + ': ' + e.message; }
  }
  throw new Error('IA indisponible - ' + (lastErr || 'aucun fournisseur configure'));
}

function getImgUrl(item){
  if(!item) return null;
  return typeof item === 'object' ? item.url : item;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description: "Cherche des produits dans la boutique par nom, categorie ou mots-cles. Utilise ceci des qu'un client demande un produit, un prix, ou une comparaison.",
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
  }
];

async function execTool(name, input){
  if(name === 'search_products'){
    const r = await fetch(FB_DB + '/products.json');
    const data = await r.json();
    if(!data) return { products: [] };
    let list = Object.entries(data).map(([key,p]) => ({
      id: key, name: p.name, price: p.price, old_price: p.old_price || null,
      category: p.category, availability: p.availability || 'stock',
      delayDays: p.delayDays || null, stock: p.stock,
      url: 'https://embfboutik.vercel.app/produit/' + (p.slug || key)
    }));
    if(input.category) list = list.filter(p => p.category === input.category);
    if(input.availability) list = list.filter(p => p.availability === input.availability);
    if(input.query){
      const q = input.query.toLowerCase();
      list = list.filter(p => (p.name||'').toLowerCase().includes(q));
    }
    return { products: list.slice(0, 15) };
  }
  if(name === 'get_promo'){
    const r = await fetch(FB_DB + '/promo.json');
    const data = await r.json();
    return data || { active: false };
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

  const SYSTEM = `Tu es Rachida, l'assistante d'achat de EMBF Boutique (Electro Market BF), une boutique en ligne d'equipement electronique et divers au Burkina Faso. Tu aides les visiteurs a trouver des produits, comparer des prix, comprendre les modes de livraison (stock = livraison rapide 24-72H, commande = import 10-20 jours generalement moins cher) et les moyens de paiement (Orange Money, Wave, Moov Money, ou especes a la livraison selon la zone). Pour commander, oriente toujours le client vers la page du produit (donne le lien) ou vers WhatsApp au +226 55 30 08 68. Sois chaleureuse, concise, et parle en francais. Tu ne peux ni creer ni modifier ni annuler de commande toi-meme - pour toute question sur une commande deja passee, oriente vers WhatsApp. Utilise toujours search_products pour verifier prix et disponibilite reels avant de repondre - n'invente jamais un prix ou un stock.`;

  let messages = history.length ? history : [{ role: 'system', content: SYSTEM }];
  messages.push({ role: 'user', content: userMessage });

  try{
    for(let iter = 0; iter < 4; iter++){
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
