(() => {
  'use strict';

  const API_BASE = '/api';
  let authToken = localStorage.getItem('nexa-token') || '';
  let onlineMode = false;

  async function api(path, options={}) {
    const headers = new Headers(options.headers || {});
    if (authToken) headers.set('Authorization', `Bearer ${authToken}`);
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type','application/json');
    const res = await fetch(`${API_BASE}${path}`, {...options, headers});
    let payload = null;
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) payload = await res.json().catch(()=>null);
    if (!res.ok) {
      if (res.status === 401 && authToken) { authToken=''; localStorage.removeItem('nexa-token'); }
      throw new Error(payload?.error || `Erro ${res.status}`);
    }
    return payload;
  }

  async function loadOnlineState() {
    try {
      const catalog = await api('/tracks');
      if (Array.isArray(catalog?.tracks)) {
        onlineMode = true;
        const locals = tracks.filter(t=>t.uploaded);
        tracks = [...catalog.tracks, ...locals];
      }
    } catch { onlineMode = false; }
    if (!onlineMode || !authToken) return;
    try {
      const [{user}, library] = await Promise.all([api('/me'), api('/library')]);
      state.user = user;
      state.favorites = library.favorites || [];
      state.playlists = library.playlists || [];
      state.recent = library.recent || [];
      saveState();
    } catch {
      authToken=''; localStorage.removeItem('nexa-token');
      state.user={name:'Visitante'};
    }
  }

  const BUILTIN_TRACKS = [
    {id:'aurora', title:'Aurora Digital', artist:'Nexa Sessions', album:'Frequências', genre:'Eletrônica', year:2026, duration:24, cover:'assets/covers/aurora.svg', src:'/api/demo-audio/aurora.wav'},
    {id:'neon', title:'Cidade Neon', artist:'Lina Vale', album:'Entre Luzes', genre:'Pop', year:2026, duration:24, cover:'assets/covers/neon.svg', src:'/api/demo-audio/neon.wav'},
    {id:'solar', title:'Pulso Solar', artist:'Caio Lume', album:'Órbita', genre:'Eletrônica', year:2026, duration:24, cover:'assets/covers/solar.svg', src:'/api/demo-audio/solar.wav'},
    {id:'noite', title:'Depois da Meia-Noite', artist:'Mira', album:'Noite Clara', genre:'Lo-fi', year:2026, duration:24, cover:'assets/covers/noite.svg', src:'/api/demo-audio/noite.wav'},
    {id:'oceano', title:'Maré Azul', artist:'Nora Azul', album:'Oceano Interno', genre:'Ambient', year:2026, duration:24, cover:'assets/covers/oceano.svg', src:'/api/demo-audio/oceano.wav'},
    {id:'horizonte', title:'Linha do Horizonte', artist:'Theo Serra', album:'Caminhos', genre:'Instrumental', year:2026, duration:24, cover:'assets/covers/horizonte.svg', src:'/api/demo-audio/horizonte.wav'}
  ];

  const defaultState = {
    user: {name:'Visitante', email:'', isAdmin:false},
    favorites: ['aurora','noite'],
    playlists: [
      {id:'pl-foco', name:'Foco & Fluxo', description:'Para trabalhar, estudar e entrar no ritmo.', trackIds:['noite','oceano','horizonte']},
      {id:'pl-energia', name:'Energia', description:'Batidas para manter o dia em movimento.', trackIds:['aurora','neon','solar']}
    ],
    recent: [],
    currentTrackId: null,
    volume: .75,
    shuffle: false,
    repeat: 'off'
  };

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const content = $('#content');
  const audio = $('#audio');
  let tracks = [...BUILTIN_TRACKS];
  let currentView = 'home';
  let currentPlaylistId = null;
  let queue = [];
  let queueIndex = -1;
  let deferredInstallPrompt = null;
  let navigationStack = ['home'];
  let navIndex = 0;

  const loadState = () => {
    try { return {...defaultState, ...JSON.parse(localStorage.getItem('nexa-state') || '{}')}; }
    catch { return structuredClone(defaultState); }
  };
  let state = loadState();
  const saveState = () => localStorage.setItem('nexa-state', JSON.stringify(state));

  function escapeHTML(v='') { return String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function formatTime(sec) { if(!Number.isFinite(sec)) return '0:00'; const m=Math.floor(sec/60), s=Math.floor(sec%60); return `${m}:${String(s).padStart(2,'0')}`; }
  function getTrack(id) { return tracks.find(t => t.id === id); }
  function toast(message) {
    const el=document.createElement('div'); el.className='toast'; el.textContent=message; $('#toastRoot').appendChild(el);
    setTimeout(()=>el.remove(), 2600);
  }
  function setActiveNav(view) {
    $$('.nav-item,.mobile-nav-item').forEach(b => b.classList.toggle('active', b.dataset.view===view));
  }
  function pushHistory(token) {
    navigationStack = navigationStack.slice(0, navIndex+1); navigationStack.push(token); navIndex=navigationStack.length-1;
  }
  function navigate(view, opts={}) {
    currentView=view; currentPlaylistId=opts.playlistId || null; setActiveNav(view);
    if(!opts.historySilent) pushHistory(view==='playlist'?`playlist:${currentPlaylistId}`:view);
    render(); content.focus({preventScroll:true}); document.querySelector('.main-shell')?.scrollTo({top:0,behavior:'smooth'});
  }
  function navigateToken(token, silent=true){
    if(token.startsWith('playlist:')) navigate('playlist',{playlistId:token.split(':')[1],historySilent:silent}); else navigate(token,{historySilent:silent});
  }

  function renderPlaylistNav(){
    $('#playlistNav').innerHTML=state.playlists.map(p=>`<button class="playlist-link" data-playlist="${p.id}">${escapeHTML(p.name)}</button>`).join('');
    $$('#playlistNav [data-playlist]').forEach(b=>b.addEventListener('click',()=>navigate('playlist',{playlistId:b.dataset.playlist})));
  }

  function render(){
    renderPlaylistNav();
    if(currentView==='home') renderHome();
    else if(currentView==='search') renderSearch();
    else if(currentView==='library') renderLibrary();
    else if(currentView==='playlist') renderPlaylist(currentPlaylistId);
  }

  function card(track){
    return `<article class="music-card" data-track-card="${track.id}">
      <div class="cover-wrap"><img src="${track.cover}" alt="Capa de ${escapeHTML(track.title)}"><button class="card-play" data-play="${track.id}" aria-label="Tocar ${escapeHTML(track.title)}">▶</button></div>
      <h3>${escapeHTML(track.title)}</h3><p>${escapeHTML(track.artist)}</p>
    </article>`;
  }
  function bindCards(root=content){
    root.querySelectorAll('[data-play]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation(); playTrack(b.dataset.play);}));
    root.querySelectorAll('[data-track-card]').forEach(c=>c.addEventListener('dblclick',()=>playTrack(c.dataset.trackCard)));
  }

  function renderHome(){
    const recentTracks=state.recent.map(getTrack).filter(Boolean).slice(0,6);
    const quick=(recentTracks.length?recentTracks:tracks).slice(0,6);
    content.innerHTML=`
      <section class="hero">
        <div class="hero-copy"><span class="eyebrow">Sua trilha começa aqui</span><h1>Música para o seu momento.</h1><p>Descubra, salve, organize e ouça. O catálogo desta demonstração é original e foi criado para testar o player sem depender de serviços externos.</p>
          <div class="hero-actions"><button class="primary-btn" id="heroPlay">▶ Tocar agora</button><button class="secondary-btn" id="heroExplore">Explorar catálogo</button></div>
        </div>
      </section>
      <div class="quick-grid">${quick.map(t=>`<button class="quick-item" data-play="${t.id}"><img src="${t.cover}" alt=""><span>${escapeHTML(t.title)}</span></button>`).join('')}</div>
      <section class="section"><div class="section-head"><h2>Feito para você</h2><button data-go="search">Ver tudo</button></div><div class="card-grid">${tracks.map(card).join('')}</div></section>
      <section class="section"><div class="section-head"><h2>Suas playlists</h2><button id="homeNewPlaylist">Criar playlist</button></div><div class="card-grid">${state.playlists.map(playlistCard).join('')}</div></section>
    `;
    $('#heroPlay').onclick=()=>playTrack(quick[0]?.id || tracks[0].id);
    $('#heroExplore').onclick=()=>navigate('search');
    $('[data-go="search"]').onclick=()=>navigate('search');
    $('#homeNewPlaylist').onclick=showCreatePlaylist;
    bindCards(); bindPlaylistCards();
  }

  function playlistCard(p){
    const first=getTrack(p.trackIds[0]);
    return `<article class="music-card" data-open-playlist="${p.id}"><div class="cover-wrap">${first?`<img src="${first.cover}" alt="">`:`<div class="playlist-cover" style="width:100%;font-size:52px">♫</div>`}</div><h3>${escapeHTML(p.name)}</h3><p>${p.trackIds.length} música${p.trackIds.length===1?'':'s'}</p></article>`;
  }
  function bindPlaylistCards(){
    $$('[data-open-playlist]').forEach(c=>c.addEventListener('click',()=>navigate('playlist',{playlistId:c.dataset.openPlaylist})));
  }

  function renderSearch(query=''){
    const q=query.trim().toLowerCase();
    const results=q?tracks.filter(t=>[t.title,t.artist,t.album,t.genre].some(v=>v.toLowerCase().includes(q))):[];
    content.innerHTML=`<h1 class="view-title">Buscar</h1><p class="view-sub">Encontre músicas, artistas, álbuns e estilos.</p>
      <div class="search-wrap"><input id="searchInput" type="search" placeholder="O que você quer ouvir?" value="${escapeHTML(query)}" autocomplete="off"><span class="search-icon">⌕</span></div>
      <div id="searchBody">${q?searchResults(results,q):genreBrowse()}</div>`;
    const input=$('#searchInput'); input.focus(); input.setSelectionRange(input.value.length,input.value.length);
    input.addEventListener('input',()=>{
      const qq=input.value.trim().toLowerCase(); const rr=qq?tracks.filter(t=>[t.title,t.artist,t.album,t.genre].some(v=>v.toLowerCase().includes(qq))):[];
      $('#searchBody').innerHTML=qq?searchResults(rr,qq):genreBrowse(); bindSearchDynamic();
    });
    bindSearchDynamic();
  }
  function genreBrowse(){
    const genres=[...new Set(tracks.map(t=>t.genre))];
    return `<section class="section" style="margin-top:0"><div class="section-head"><h2>Navegar por estilos</h2></div><div class="genre-grid">${genres.map(g=>`<button class="genre-card" data-genre="${escapeHTML(g)}">${escapeHTML(g)}</button>`).join('')}</div></section>`;
  }
  function searchResults(results,q){
    if(!results.length) return `<div class="empty"><strong>Nada encontrado</strong>Tente buscar por outro título, artista ou estilo.</div>`;
    return `<section class="section" style="margin-top:0"><div class="section-head"><h2>Resultados para “${escapeHTML(q)}”</h2></div><div class="card-grid">${results.map(card).join('')}</div></section>`;
  }
  function bindSearchDynamic(){
    bindCards($('#searchBody'));
    $$('#searchBody [data-genre]').forEach(b=>b.addEventListener('click',()=>{const i=$('#searchInput'); i.value=b.dataset.genre; i.dispatchEvent(new Event('input'));}));
  }

  function renderLibrary(filter='all'){
    const favs=state.favorites.map(getTrack).filter(Boolean);
    content.innerHTML=`<h1 class="view-title">Sua biblioteca</h1><p class="view-sub">Tudo o que você curtiu e organizou em um só lugar.</p>
      <div class="library-actions"><button class="filter-chip ${filter==='all'?'active':''}" data-filter="all">Tudo</button><button class="filter-chip ${filter==='favorites'?'active':''}" data-filter="favorites">Curtidas</button><button class="filter-chip ${filter==='playlists'?'active':''}" data-filter="playlists">Playlists</button><button class="secondary-btn" id="importTrackBtn">＋ Importar música</button></div>
      <div id="libraryBody">${libraryBody(filter,favs)}</div>`;
    $$('[data-filter]').forEach(b=>b.addEventListener('click',()=>renderLibrary(b.dataset.filter)));
    $('#importTrackBtn').onclick=showImportTrack;
    bindLibraryDynamic();
  }
  function libraryBody(filter,favs){
    let html='';
    if(filter==='all'||filter==='favorites') html+=`<section class="section" style="margin-top:0"><div class="section-head"><h2>Músicas curtidas</h2></div>${favs.length?trackTable(favs):'<div class="empty"><strong>Nenhuma curtida ainda</strong>Toque no coração de uma música para guardá-la aqui.</div>'}</section>`;
    if(filter==='all'||filter==='playlists') html+=`<section class="section"><div class="section-head"><h2>Playlists</h2><button id="libNewPlaylist">Nova playlist</button></div><div class="card-grid">${state.playlists.map(playlistCard).join('')}</div></section>`;
    return html;
  }
  function bindLibraryDynamic(){
    bindTrackRows(); bindPlaylistCards(); const b=$('#libNewPlaylist'); if(b)b.onclick=showCreatePlaylist;
  }

  function trackTable(list, playlistId=null){
    return `<table class="table"><thead><tr><th># / Música</th><th>Álbum</th><th>Estilo</th><th style="text-align:right">Ações</th></tr></thead><tbody>${list.map((t,i)=>`<tr data-row-track="${t.id}"><td><div class="track-cell"><span style="width:20px;color:#71717a">${i+1}</span><img src="${t.cover}" alt=""><div><strong>${escapeHTML(t.title)}</strong><span>${escapeHTML(t.artist)}</span></div></div></td><td>${escapeHTML(t.album)}</td><td><span class="badge">${escapeHTML(t.genre)}</span></td><td><div class="inline-actions"><button data-fav="${t.id}" title="Curtir">${state.favorites.includes(t.id)?'♥':'♡'}</button><button data-add="${t.id}" title="Adicionar a playlist">＋</button>${playlistId?`<button data-remove="${t.id}" data-from="${playlistId}" title="Remover">×</button>`:''}</div></td></tr>`).join('')}</tbody></table>`;
  }
  function bindTrackRows(root=content){
    root.querySelectorAll('[data-row-track]').forEach(r=>r.addEventListener('dblclick',()=>playTrack(r.dataset.rowTrack)));
    root.querySelectorAll('[data-fav]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();toggleFavorite(b.dataset.fav); render();}));
    root.querySelectorAll('[data-add]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();showAddToPlaylist(b.dataset.add);}));
    root.querySelectorAll('[data-remove]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();removeFromPlaylist(b.dataset.remove,b.dataset.from);}));
  }

  function renderPlaylist(id){
    const p=state.playlists.find(x=>x.id===id);
    if(!p){navigate('library');return;}
    const list=p.trackIds.map(getTrack).filter(Boolean);
    content.innerHTML=`<section class="playlist-hero"><div class="playlist-cover">${escapeHTML(p.name.charAt(0).toUpperCase() || '♫')}</div><div class="playlist-meta"><span class="eyebrow">Playlist</span><h1>${escapeHTML(p.name)}</h1><p>${escapeHTML(p.description||'Sua seleção musical.')} • ${list.length} música${list.length===1?'':'s'}</p></div></section>
      <div class="library-actions"><button class="primary-btn" id="playlistPlay">▶ Tocar</button><button class="secondary-btn" id="playlistEdit">Editar</button><button class="secondary-btn" id="playlistDelete">Excluir</button></div>
      ${list.length?trackTable(list,p.id):'<div class="empty"><strong>Playlist vazia</strong>Use o botão “＋” nas músicas para adicioná-las.</div>'}`;
    $('#playlistPlay').onclick=()=>{if(list.length){queue=list.map(t=>t.id);queueIndex=0;playTrack(queue[0],false);updateQueueCount();}};
    $('#playlistEdit').onclick=()=>showEditPlaylist(p.id);
    $('#playlistDelete').onclick=()=>deletePlaylist(p.id);
    bindTrackRows();
  }

  function updatePlayerUI(track){
    if(!track) return;
    $('#playerCover').src=track.cover; $('#playerTitle').textContent=track.title; $('#playerArtist').textContent=track.artist;
    $('#favoriteBtn').classList.toggle('active',state.favorites.includes(track.id)); $('#favoriteBtn').textContent=state.favorites.includes(track.id)?'♥':'♡';
    if('mediaSession' in navigator){
      navigator.mediaSession.metadata=new MediaMetadata({title:track.title,artist:track.artist,album:track.album,artwork:[{src:new URL(track.cover,location.href).href,sizes:'512x512'}]});
    }
  }
  async function playTrack(id, resetQueue=true){
    const track=getTrack(id); if(!track)return;
    if(resetQueue){queue=tracks.map(t=>t.id);queueIndex=Math.max(0,queue.indexOf(id));}
    const changed=state.currentTrackId!==id;
    state.currentTrackId=id; state.recent=[id,...state.recent.filter(x=>x!==id)].slice(0,20); saveState(); updatePlayerUI(track); updateQueueCount();
    if(authToken&&onlineMode) api('/history',{method:'POST',body:JSON.stringify({trackId:id})}).catch(()=>{});
    if(changed || !audio.src){ audio.src=track.src; audio.load(); }
    try { await audio.play(); } catch { toast('Toque no botão de play para iniciar o áudio.'); }
    updatePlayButton();
  }
  function updatePlayButton(){ $('#playBtn').textContent=audio.paused?'▶':'❚❚'; }
  function togglePlay(){
    if(!state.currentTrackId){playTrack(tracks[0].id);return;}
    audio.paused?audio.play():audio.pause();
  }
  async function toggleFavorite(id=state.currentTrackId){
    if(!id)return;
    const removing=state.favorites.includes(id);
    if(removing){state.favorites=state.favorites.filter(x=>x!==id);toast('Removida das curtidas');}
    else{state.favorites.unshift(id);toast('Adicionada às curtidas');}
    saveState(); const t=getTrack(id); if(t&&id===state.currentTrackId)updatePlayerUI(t);
    if(authToken&&onlineMode){
      try{await api(`/favorites/${encodeURIComponent(id)}`,{method:removing?'DELETE':'PUT'});}catch(e){toast(e.message);}
    }
  }
  function nextTrack(manual=false){
    if(!queue.length) queue=tracks.map(t=>t.id);
    if(state.shuffle){ let n=queueIndex; while(queue.length>1&&n===queueIndex)n=Math.floor(Math.random()*queue.length); queueIndex=n; }
    else { queueIndex++; if(queueIndex>=queue.length){ if(state.repeat==='all'||manual)queueIndex=0; else {audio.pause();updatePlayButton();return;} } }
    playTrack(queue[queueIndex],false);
  }
  function prevTrack(){ if(audio.currentTime>4){audio.currentTime=0;return;} if(!queue.length)return;queueIndex=(queueIndex-1+queue.length)%queue.length;playTrack(queue[queueIndex],false); }
  function updateQueueCount(){ $('#queueCount').textContent=Math.max(0,queue.length-(queueIndex+1)); }

  function modal(html, cls=''){
    $('#modalRoot').innerHTML=`<div class="modal-backdrop" id="modalBackdrop"><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
    $('#modalBackdrop').addEventListener('click',e=>{if(e.target.id==='modalBackdrop')closeModal();});
  }
  function closeModal(){ $('#modalRoot').innerHTML=''; }
  function showCreatePlaylist(){
    modal(`<h2>Nova playlist</h2><p>Dê um nome para sua nova seleção.</p><label>Nome<input id="playlistName" maxlength="60" placeholder="Minha playlist"></label><label>Descrição<input id="playlistDesc" maxlength="120" placeholder="Opcional"></label><div class="modal-actions"><button class="secondary-btn" id="cancelModal">Cancelar</button><button class="primary-btn" id="savePlaylist">Criar</button></div>`);
    $('#cancelModal').onclick=closeModal; $('#playlistName').focus();
    $('#savePlaylist').onclick=async()=>{
      const name=$('#playlistName').value.trim(); const description=$('#playlistDesc').value.trim();
      if(!name){toast('Digite um nome para a playlist.');return;}
      let p;
      if(authToken&&onlineMode){
        try{const r=await api('/playlists',{method:'POST',body:JSON.stringify({name,description})});p=r.playlist;}catch(e){toast(e.message);return;}
      }else p={id:'pl-'+Date.now(),name,description,trackIds:[]};
      state.playlists.unshift(p);saveState();closeModal();renderPlaylistNav();navigate('playlist',{playlistId:p.id});
    };
  }

  function showEditPlaylist(id){
    const p=state.playlists.find(x=>x.id===id);if(!p)return;
    modal(`<h2>Editar playlist</h2><label>Nome<input id="playlistName" maxlength="60" value="${escapeHTML(p.name)}"></label><label>Descrição<input id="playlistDesc" maxlength="120" value="${escapeHTML(p.description||'')}"></label><div class="modal-actions"><button class="secondary-btn" id="cancelModal">Cancelar</button><button class="primary-btn" id="savePlaylist">Salvar</button></div>`);
    $('#cancelModal').onclick=closeModal; $('#savePlaylist').onclick=async()=>{
      const name=$('#playlistName').value.trim(),description=$('#playlistDesc').value.trim();if(!name)return;
      if(authToken&&onlineMode){try{await api(`/playlists/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify({name,description})});}catch(e){toast(e.message);return;}}
      p.name=name;p.description=description;saveState();closeModal();render();toast('Playlist atualizada');
    };
  }

  function deletePlaylist(id){
    const p=state.playlists.find(x=>x.id===id);if(!p)return;
    modal(`<h2>Excluir playlist?</h2><p>“${escapeHTML(p.name)}” será removida da sua biblioteca. As músicas continuam disponíveis.</p><div class="modal-actions"><button class="secondary-btn" id="cancelModal">Cancelar</button><button class="primary-btn" id="confirmDelete">Excluir</button></div>`);
    $('#cancelModal').onclick=closeModal;$('#confirmDelete').onclick=async()=>{
      if(authToken&&onlineMode){try{await api(`/playlists/${encodeURIComponent(id)}`,{method:'DELETE'});}catch(e){toast(e.message);return;}}
      state.playlists=state.playlists.filter(x=>x.id!==id);saveState();closeModal();navigate('library');toast('Playlist excluída');
    };
  }

  function showAddToPlaylist(trackId){
    modal(`<h2>Adicionar à playlist</h2><p>Escolha onde guardar esta música.</p><div class="queue-list">${state.playlists.map(p=>`<button class="queue-item" data-target-playlist="${p.id}" style="width:100%;text-align:left"><div class="playlist-cover" style="width:44px;font-size:18px;border-radius:7px">${escapeHTML(p.name[0]||'♫')}</div><div class="queue-meta"><strong>${escapeHTML(p.name)}</strong><span>${p.trackIds.length} músicas</span></div></button>`).join('')||'<div class="empty">Você ainda não tem playlists.</div>'}</div><div class="modal-actions"><button class="secondary-btn" id="makePlaylistFromAdd">＋ Nova playlist</button><button class="secondary-btn" id="cancelModal">Fechar</button></div>`);
    $('#cancelModal').onclick=closeModal; $('#makePlaylistFromAdd').onclick=()=>{closeModal();showCreatePlaylist();};
    $$('[data-target-playlist]').forEach(b=>b.addEventListener('click',async()=>{
      const p=state.playlists.find(x=>String(x.id)===String(b.dataset.targetPlaylist));
      if(!p.trackIds.includes(trackId)){
        if(authToken&&onlineMode){try{await api(`/playlists/${encodeURIComponent(p.id)}/tracks`,{method:'POST',body:JSON.stringify({trackId})});}catch(e){toast(e.message);return;}}
        p.trackIds.push(trackId);saveState();
      }
      closeModal();toast(`Adicionada a “${p.name}”`);renderPlaylistNav();
    }));
  }

  async function removeFromPlaylist(trackId,playlistId){const p=state.playlists.find(x=>String(x.id)===String(playlistId));if(!p)return;if(authToken&&onlineMode){try{await api(`/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`,{method:'DELETE'});}catch(e){toast(e.message);return;}}p.trackIds=p.trackIds.filter(x=>x!==trackId);saveState();render();toast('Música removida da playlist');}

  async function openDB(){
    return new Promise((resolve,reject)=>{const req=indexedDB.open('nexa-music-db',1);req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('tracks'))db.createObjectStore('tracks',{keyPath:'id'});};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  }
  async function loadUploadedTracks(){
    try{const db=await openDB();const items=await new Promise((resolve,reject)=>{const r=db.transaction('tracks','readonly').objectStore('tracks').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      items.forEach(item=>{const url=URL.createObjectURL(item.blob);tracks.push({...item,src:url,uploaded:true,blob:undefined});});
    }catch(e){console.warn('IndexedDB indisponível',e);}
  }
  function showImportTrack(){
    modal(`<h2>Importar música</h2><p>Adicione um arquivo de áudio do seu dispositivo. Ele será guardado localmente neste navegador.</p><label>Arquivo de áudio<input id="audioFile" type="file" accept="audio/*"></label><label>Título<input id="trackTitle" maxlength="80"></label><label>Artista<input id="trackArtist" maxlength="80" placeholder="Artista independente"></label><label>Álbum<input id="trackAlbum" maxlength="80" placeholder="Importações"></label><div class="modal-actions"><button class="secondary-btn" id="cancelModal">Cancelar</button><button class="primary-btn" id="saveImport">Importar</button></div>`);
    $('#cancelModal').onclick=closeModal;
    $('#audioFile').addEventListener('change',()=>{const f=$('#audioFile').files[0];if(f&&!$('#trackTitle').value)$('#trackTitle').value=f.name.replace(/\.[^.]+$/,'');});
    $('#saveImport').onclick=async()=>{const f=$('#audioFile').files[0],title=$('#trackTitle').value.trim();if(!f||!title){toast('Escolha um arquivo e informe o título.');return;}const id='up-'+Date.now();const item={id,title,artist:$('#trackArtist').value.trim()||'Artista local',album:$('#trackAlbum').value.trim()||'Importações',genre:'Importada',year:new Date().getFullYear(),duration:0,cover:'assets/covers/aurora.svg',blob:f};try{const db=await openDB();await new Promise((resolve,reject)=>{const r=db.transaction('tracks','readwrite').objectStore('tracks').put(item);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);});tracks.push({...item,src:URL.createObjectURL(f),uploaded:true,blob:undefined});closeModal();renderLibrary();toast('Música importada com sucesso');}catch{toast('Não foi possível guardar o arquivo neste navegador.');}};
  }

  function showProfile(){
    if(!authToken || !state.user?.email){ showLogin(); return; }
    const adminButton=state.user?.isAdmin?'<button class="secondary-btn" id="adminUpload">Publicar música</button>':'';
    modal(`<h2>Sua conta</h2><p>${escapeHTML(state.user.email||'')} ${onlineMode?'• sincronizada na nuvem':'• modo local'}</p><label>Nome<input id="profileInput" maxlength="50" value="${escapeHTML(state.user?.name||'')}"></label><div class="modal-actions">${adminButton}<button class="secondary-btn" id="logoutBtn">Sair</button><button class="secondary-btn" id="cancelModal">Cancelar</button><button class="primary-btn" id="saveProfile">Salvar</button></div>`);
    $('#cancelModal').onclick=closeModal;
    $('#logoutBtn').onclick=()=>{authToken='';localStorage.removeItem('nexa-token');state={...defaultState,user:{name:'Visitante',email:'',isAdmin:false},volume:state.volume,shuffle:state.shuffle,repeat:state.repeat};saveState();closeModal();updateProfile();render();toast('Você saiu da conta');};
    $('#saveProfile').onclick=async()=>{const name=$('#profileInput').value.trim();if(!name)return;try{if(onlineMode){const r=await api('/me',{method:'PUT',body:JSON.stringify({name})});state.user=r.user;}else state.user={...state.user,name};saveState();updateProfile();closeModal();toast('Perfil atualizado');}catch(e){toast(e.message);}};
    if(state.user?.isAdmin) $('#adminUpload').onclick=()=>{closeModal();showAdminUpload();};
  }

  function showLogin(){
    modal(`<h2>Entrar no Nexa</h2><p>Entre para sincronizar playlists, curtidas e histórico entre seus dispositivos.</p><label>E-mail<input id="loginEmail" type="email" autocomplete="email"></label><label>Senha<input id="loginPassword" type="password" autocomplete="current-password"></label><div class="modal-actions"><button class="secondary-btn" id="makeAccount">Criar conta</button><button class="secondary-btn" id="cancelModal">Cancelar</button><button class="primary-btn" id="loginSubmit">Entrar</button></div>`);
    $('#cancelModal').onclick=closeModal; $('#makeAccount').onclick=showRegister;
    $('#loginSubmit').onclick=async()=>{
      if(!onlineMode){toast('Servidor online indisponível nesta execução.');return;}
      try{const r=await api('/auth/login',{method:'POST',body:JSON.stringify({email:$('#loginEmail').value,password:$('#loginPassword').value})});authToken=r.token;localStorage.setItem('nexa-token',authToken);state.user=r.user;const lib=await api('/library');state.favorites=lib.favorites||[];state.playlists=lib.playlists||[];state.recent=lib.recent||[];saveState();updateProfile();closeModal();render();toast('Login realizado');}catch(e){toast(e.message);}
    };
  }

  function showRegister(){
    modal(`<h2>Criar conta</h2><p>Seus dados de biblioteca ficam vinculados à sua conta.</p><label>Nome<input id="regName" maxlength="100" autocomplete="name"></label><label>E-mail<input id="regEmail" type="email" autocomplete="email"></label><label>Senha<input id="regPassword" type="password" minlength="8" autocomplete="new-password"></label><div class="modal-actions"><button class="secondary-btn" id="backLogin">Já tenho conta</button><button class="secondary-btn" id="cancelModal">Cancelar</button><button class="primary-btn" id="registerSubmit">Criar conta</button></div>`);
    $('#cancelModal').onclick=closeModal;$('#backLogin').onclick=showLogin;
    $('#registerSubmit').onclick=async()=>{
      if(!onlineMode){toast('Servidor online indisponível nesta execução.');return;}
      try{const r=await api('/auth/register',{method:'POST',body:JSON.stringify({name:$('#regName').value,email:$('#regEmail').value,password:$('#regPassword').value})});authToken=r.token;localStorage.setItem('nexa-token',authToken);state.user=r.user;state.favorites=[];state.playlists=[];state.recent=[];saveState();updateProfile();closeModal();render();toast('Conta criada com sucesso');}catch(e){toast(e.message);}
    };
  }

  function showAdminUpload(){
    modal(`<h2>Publicar música</h2><p>Envie apenas áudio que você tenha autorização para distribuir.</p><label>Áudio<input id="adminAudio" type="file" accept="audio/*"></label><label>Capa<input id="adminCover" type="file" accept="image/*"></label><label>Título<input id="adminTitle" maxlength="180"></label><label>Artista<input id="adminArtist" maxlength="180"></label><label>Álbum<input id="adminAlbum" maxlength="180"></label><label>Estilo<input id="adminGenre" maxlength="100"></label><div class="modal-actions"><button class="secondary-btn" id="cancelModal">Cancelar</button><button class="primary-btn" id="publishTrack">Publicar</button></div>`,'large');
    $('#cancelModal').onclick=closeModal;
    $('#publishTrack').onclick=async()=>{
      const audioFile=$('#adminAudio').files[0];if(!audioFile||!$('#adminTitle').value.trim()||!$('#adminArtist').value.trim()){toast('Informe áudio, título e artista.');return;}
      const fd=new FormData();fd.append('audio',audioFile);const cover=$('#adminCover').files[0];if(cover)fd.append('cover',cover);fd.append('title',$('#adminTitle').value.trim());fd.append('artist',$('#adminArtist').value.trim());fd.append('album',$('#adminAlbum').value.trim());fd.append('genre',$('#adminGenre').value.trim());fd.append('year',String(new Date().getFullYear()));
      try{await api('/admin/tracks',{method:'POST',body:fd});const catalog=await api('/tracks');const locals=tracks.filter(t=>t.uploaded);tracks=[...(catalog.tracks||[]),...locals];closeModal();render();toast('Música publicada no catálogo');}catch(e){toast(e.message);}
    };
  }

  function updateProfile(){const n=state.user?.name||'Visitante';$('#profileName').textContent=state.user?.email?n:'Entrar';$('#avatarInitial').textContent=(n[0]||'V').toUpperCase();}

  function showQueue(){
    if(!queue.length)queue=tracks.map(t=>t.id);
    const upcoming=queue.slice(Math.max(0,queueIndex+1)).map(getTrack).filter(Boolean);
    modal(`<h2>Fila de reprodução</h2><p>${upcoming.length} música${upcoming.length===1?'':'s'} a seguir.</p><div class="queue-list">${upcoming.map(t=>`<div class="queue-item"><img src="${t.cover}" alt=""><div class="queue-meta"><strong>${escapeHTML(t.title)}</strong><span>${escapeHTML(t.artist)}</span></div><button data-queue-play="${t.id}">▶</button></div>`).join('')||'<div class="empty">Não há músicas na fila.</div>'}</div><div class="modal-actions"><button class="secondary-btn" id="closeQueue">Fechar</button></div>`,'large');
    $('#closeQueue').onclick=closeModal;$$('[data-queue-play]').forEach(b=>b.onclick=()=>{queueIndex=queue.indexOf(b.dataset.queuePlay);playTrack(b.dataset.queuePlay,false);closeModal();});
  }

  function wireGlobalEvents(){
    $$('[data-view]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));
    $('#newPlaylistBtn').onclick=showCreatePlaylist; $('#profileBtn').onclick=showProfile; $('#queueBtn').onclick=showQueue; $('#miniQueueBtn').onclick=showQueue;
    $('#playBtn').onclick=togglePlay; $('#prevBtn').onclick=prevTrack; $('#nextBtn').onclick=()=>nextTrack(true); $('#favoriteBtn').onclick=()=>toggleFavorite();
    $('#shuffleBtn').onclick=()=>{state.shuffle=!state.shuffle;saveState();$('#shuffleBtn').classList.toggle('active',state.shuffle);toast(state.shuffle?'Aleatório ativado':'Aleatório desativado');};
    $('#repeatBtn').onclick=()=>{state.repeat=state.repeat==='off'?'all':state.repeat==='all'?'one':'off';saveState();$('#repeatBtn').classList.toggle('active',state.repeat!=='off');$('#repeatBtn').textContent=state.repeat==='one'?'↻1':'↻';toast(state.repeat==='off'?'Repetição desativada':state.repeat==='all'?'Repetir fila':'Repetir música');};
    $('#volume').value=state.volume; audio.volume=state.volume; $('#volume').addEventListener('input',e=>{state.volume=Number(e.target.value);audio.volume=state.volume;saveState();});
    $('#progress').addEventListener('input',e=>{if(audio.duration)audio.currentTime=(Number(e.target.value)/100)*audio.duration;});
    audio.addEventListener('timeupdate',()=>{if(audio.duration){$('#progress').value=(audio.currentTime/audio.duration)*100;$('#currentTime').textContent=formatTime(audio.currentTime);$('#duration').textContent=formatTime(audio.duration);}});
    audio.addEventListener('loadedmetadata',()=>{$('#duration').textContent=formatTime(audio.duration);});
    audio.addEventListener('play',updatePlayButton);audio.addEventListener('pause',updatePlayButton);
    audio.addEventListener('ended',()=>{if(state.repeat==='one'){audio.currentTime=0;audio.play();}else nextTrack(false);});
    $('#backBtn').onclick=()=>{if(navIndex>0){navIndex--;navigateToken(navigationStack[navIndex]);}};
    $('#forwardBtn').onclick=()=>{if(navIndex<navigationStack.length-1){navIndex++;navigateToken(navigationStack[navIndex]);}};
    document.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select'))return;if(e.code==='Space'){e.preventDefault();togglePlay();}if(e.code==='ArrowRight'&&e.altKey)nextTrack(true);if(e.code==='ArrowLeft'&&e.altKey)prevTrack();});
    if('mediaSession' in navigator){navigator.mediaSession.setActionHandler('play',()=>audio.play());navigator.mediaSession.setActionHandler('pause',()=>audio.pause());navigator.mediaSession.setActionHandler('previoustrack',prevTrack);navigator.mediaSession.setActionHandler('nexttrack',()=>nextTrack(true));}
    window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;$('#installBtn').hidden=false;});
    $('#installBtn').onclick=async()=>{if(!deferredInstallPrompt)return;deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$('#installBtn').hidden=true;};
  }

  async function init(){
    await loadUploadedTracks(); await loadOnlineState(); updateProfile(); render(); wireGlobalEvents();
    $('#shuffleBtn').classList.toggle('active',state.shuffle);$('#repeatBtn').classList.toggle('active',state.repeat!=='off');$('#repeatBtn').textContent=state.repeat==='one'?'↻1':'↻';
    if(state.currentTrackId&&getTrack(state.currentTrackId)){const t=getTrack(state.currentTrackId);audio.src=t.src;updatePlayerUI(t);queue=tracks.map(x=>x.id);queueIndex=queue.indexOf(t.id);updateQueueCount();}
    if('serviceWorker' in navigator && location.protocol!=='file:') navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }

  init();
})();
