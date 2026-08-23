/* Fast Maps service worker.
   Two caches, deliberately different:
     SHELL  — the app itself. Network-first, cache as offline fallback.
     TILES  — map tiles the user has ALREADY VIEWED. Cache-first, LRU-capped.
   There is no bulk tile prefetch and no "download this area" feature: OSM and
   CARTO tile policies forbid systematic bulk downloading. This only keeps what
   you actually looked at, and the user can cap or clear it.
   Routing and transit responses are NEVER cached — a stale departure time is
   worse than no departure time. */

var SHELL_CACHE='fastmaps-shell-v2';
var TILE_CACHE='fastmaps-tiles-v2';
var CFG_CACHE='fastmaps-cfg-v1';
var TILE_MAX_DEFAULT=1200;

var SHELL=[
  './','./index.html','./manifest.webmanifest',
  './icon-192.png','./icon-512.png','./icon-512-maskable.png','./apple-touch-icon.png'
];
var TILE_HOSTS=[
  'tile.openstreetmap.org',
  'basemaps.cartocdn.com',
  'tile-cyclosm.openstreetmap.fr',
  'tileserver.memomaps.de'
];

var cfg={tiles:true,max:TILE_MAX_DEFAULT};

function loadCfg(){
  return caches.open(CFG_CACHE).then(function(c){
    return c.match('cfg').then(function(r){
      if(!r)return cfg;
      return r.json().then(function(j){
        if(j&&typeof j==='object'){
          if(typeof j.tiles==='boolean')cfg.tiles=j.tiles;
          if(typeof j.max==='number')cfg.max=Math.max(0,Math.min(6000,j.max));
        }
        return cfg;
      }).catch(function(){return cfg;});
    });
  }).catch(function(){return cfg;});
}
function saveCfg(){
  return caches.open(CFG_CACHE).then(function(c){
    return c.put('cfg',new Response(JSON.stringify(cfg),{headers:{'Content-Type':'application/json'}}));
  });
}

self.addEventListener('install',function(e){
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function(c){
      return c.addAll(SHELL).catch(function(){/* one missing optional asset must not block install */});
    }).then(function(){return self.skipWaiting();})
  );
});

self.addEventListener('activate',function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if(k===SHELL_CACHE||k===TILE_CACHE||k===CFG_CACHE)return null;
        return caches.delete(k);
      }));
    }).then(loadCfg).then(function(){return self.clients.claim();})
  );
});

function isTile(url){
  for(var i=0;i<TILE_HOSTS.length;i++){
    if(url.hostname===TILE_HOSTS[i]||url.hostname.indexOf('.'+TILE_HOSTS[i])>=0)return true;
  }
  return false;
}
function isShell(url){
  return url.origin===self.location.origin &&
    (url.pathname.charAt(url.pathname.length-1)==='/'||/\.(html|webmanifest|png|ico|js)$/.test(url.pathname));
}

/* Keep the tile cache from growing without bound. Cache.keys() returns
   insertion order, so dropping from the front is a fair FIFO approximation
   of least-recently-added. */
var trimming=false;
function trimTiles(){
  if(trimming)return Promise.resolve();
  trimming=true;
  return caches.open(TILE_CACHE).then(function(c){
    return c.keys().then(function(keys){
      var over=keys.length-cfg.max;
      if(over<=0)return;
      var kill=keys.slice(0,over+40);   /* trim in batches, not one at a time */
      return Promise.all(kill.map(function(k){return c.delete(k);}));
    });
  }).then(function(){trimming=false;},function(){trimming=false;});
}

self.addEventListener('fetch',function(e){
  var req=e.request;
  if(req.method!=='GET')return;
  var url;
  try{url=new URL(req.url);}catch(err){return;}

  /* ---- map tiles: cache-first so the last-seen map still draws offline ---- */
  if(isTile(url)){
    if(!cfg.tiles)return;                       /* user turned tile caching off */
    e.respondWith(
      caches.open(TILE_CACHE).then(function(c){
        return c.match(req).then(function(hit){
          if(hit)return hit;
          return fetch(req).then(function(res){
            /* opaque responses (no-cors) still render; we cache by count, not bytes */
            if(res&&(res.ok||res.type==='opaque')){
              c.put(req,res.clone()).then(trimTiles).catch(function(){});
            }
            return res;
          }).catch(function(){
            return new Response('',{status:504,statusText:'Tile unavailable offline'});
          });
        });
      })
    );
    return;
  }

  /* ---- never cache live routing / geocoding / transit ---- */
  if(url.origin!==self.location.origin)return;
  if(!isShell(url))return;

  /* ---- app shell: network-first, cache is the offline net ---- */
  e.respondWith(
    fetch(req).then(function(res){
      if(res&&res.status===200){
        var copy=res.clone();
        caches.open(SHELL_CACHE).then(function(c){c.put(req,copy);}).catch(function(){});
      }
      return res;
    }).catch(function(){
      return caches.match(req).then(function(hit){
        return hit||caches.match('./index.html');
      });
    })
  );
});

/* ---- control channel from the page ---- */
self.addEventListener('message',function(e){
  var msg=e.data||{},reply=function(payload){
    if(e.ports&&e.ports[0])e.ports[0].postMessage(payload);
  };
  if(msg.type==='stats'){
    caches.open(TILE_CACHE).then(function(c){return c.keys();}).then(function(k){
      reply({tiles:k.length,max:cfg.max,enabled:cfg.tiles});
    }).catch(function(){reply({tiles:0,max:cfg.max,enabled:cfg.tiles});});
    return;
  }
  if(msg.type==='cfg'){
    if(typeof msg.tiles==='boolean')cfg.tiles=msg.tiles;
    if(typeof msg.max==='number')cfg.max=Math.max(0,Math.min(6000,msg.max));
    saveCfg().then(trimTiles).then(function(){reply({ok:true,enabled:cfg.tiles,max:cfg.max});})
      .catch(function(){reply({ok:false});});
    return;
  }
  if(msg.type==='clear-tiles'){
    caches.delete(TILE_CACHE).then(function(){reply({ok:true,tiles:0});})
      .catch(function(){reply({ok:false});});
    return;
  }
  if(msg.type==='skip-waiting'){self.skipWaiting();}
});
