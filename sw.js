var CACHE = 'embf-v3';
var ASSETS = [
  '/', '/index.html', '/produits.html', '/produit.html',
  '/contact.html', '/demande.html', '/affiliation.html',
  '/manifest.json', '/assets/icons/icon-192x192.png'
];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(ASSETS); }));
  self.skipWaiting();
});

self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){return k!==CACHE;}).map(function(k){return caches.delete(k);}));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function(e){
  if(e.request.method!=='GET')return;
  var url=e.request.url;
  // Jamais de cache pour l'admin, ni pour les appels vers des services externes
  // (Firebase, Cloudinary...) - toujours les donnees les plus fraiches, jamais figees
  var isExternal=url.indexOf(self.location.origin)!==0;
  var isAdmin=url.indexOf('embf-gestion-768x.html')!==-1||url.indexOf('admin.html')!==-1;
  if(isExternal||isAdmin){
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function(cached){
      var network = fetch(e.request).then(function(res){
        if(res&&res.status===200){
          var clone=res.clone();
          caches.open(CACHE).then(function(c){c.put(e.request,clone);});
        }
        return res;
      }).catch(function(){return cached;});
      return cached||network;
    })
  );
});
