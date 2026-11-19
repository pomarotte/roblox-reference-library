import assert from 'node:assert/strict';
import {prepareCatalogue, matchLocalFiles, decodeHalf, queryLibrary, sceneScore} from './web-core.mjs';

const image = (id, date='20260401_120000') => ({id, kind:'thumbs', filename:`${id}_${date}.webp`, captured:date});
const games = [
  {id:11,name:'100% Fun',genre:'Simulation',subgenre:'Tycoon',visits:200,status:'ready',images:[image(1),image(2,'20260402_120000')]},
  {id:22,name:'Other tycoon',genre:'Simulation',subgenre:'Tycoon',visits:100,status:'ready',images:[image(3),image(4)]},
  {id:33,name:'Action',genre:'Action',subgenre:'Fighting',visits:0,status:'ready',images:[image(5)]},
  {id:44,name:null,genre:null,subgenre:null,visits:null,status:'unavailable',images:[image(6)]}
];
const state=prepareCatalogue({games}), available=new Set([1,2,3,4,5,6]);
const query = (text, vectors=null) => queryLibrary(state,new URLSearchParams(text),available,vectors);
assert.deepEqual(query('').items.map(g=>g.image_id),[2,4,5,6]);
assert.equal(query('all_images=1').total,6);
Object.assign(games[0].images[0], {daily_category:'new-images'});
Object.assign(games[0].images[1], {daily_category:'new-images'});
Object.assign(games[1].images.find(item => item.id === 3), {daily_category:'new-images'});
Object.assign(games[2].images[0], {daily_category:'new-games'});
assert.deepEqual(query('daily_category=new-images&sort=least').items.map(g=>g.image_id),[3,2,1]);
assert.deepEqual(query('daily_category=new-images&sort=recent').items.map(g=>g.image_id),[2,1,3]);
assert.deepEqual(query('daily_category=new-games&sort=name').items.map(g=>g.image_id),[5]);
assert.deepEqual(query('all_images=1&saved_ids=[1,3,5]').items.map(g=>g.image_id),[1,3,5]);
assert.equal(query('saved_ids=[]').total,0);
assert.equal(query('kind=icons&saved_ids=[1,3,5]').total,0);
assert.throws(()=>query('saved_ids=["1"]'),/Invalid saved/);
assert.equal(query('min_visits=200&max_visits=200').total,1);
assert.deepEqual(query('min_visits=100&max_visits=200').items.map(g=>g.id),[11,22]);
assert.deepEqual(query('max_visits=0').items.map(g=>g.id),[33]);
assert.equal(query('min_visits=201').total,0);
assert.throws(()=>query('min_visits=200&max_visits=100'),/Minimum visits/);
assert.throws(()=>query('max_visits=-1'),/non-negative/);
assert.equal(query('genre=Unknown').items[0].id,44);
assert.equal(query('search=100%25').items[0].id,11);
assert.equal(query('search=%25_no_SQL').total,0);
assert.deepEqual(query('similarity=type&seed_image=1').items.map(g=>g.id),[22]);
assert.equal(query('all_images=1&offset=2&limit=2').items.length,2);
const vectors = new Float32Array(6*560);
for(let i=0;i<6;i++) { vectors[i*560]=1-i*.1; vectors[i*560+512]=1; }
const visual=query('similarity=visual&seed_image=1',vectors);
assert.deepEqual(visual.items.map(g=>g.image_id),[3,4,5,6]);
assert.equal(visual.items[0].image_count,2);
assert.equal(query('similarity=both&seed_image=1',vectors).total,2);
assert.deepEqual(query('similarity=visual&seed_image=1&saved_ids=[3,5]',vectors).items.map(g=>g.image_id),[3,5]);
assert.equal(query('similarity=visual&seed_image=1&min_visits=100&max_visits=100',vectors).total,2);
assert(Math.abs(sceneScore(vectors,2,0)-(.8+.03)/1.03)<1e-6);
assert.deepEqual([...decodeHalf(new Uint8Array([0,60,0,56,0,128,1,0]))],[1,.5,-0,2**-24]);
assert.throws(()=>decodeHalf(new Uint8Array([0,124])),/Invalid/);
const progress=[];
const local = await matchLocalFiles([{name:'ignored',size:1,webkitRelativePath:`dataset/thumbs/${games[0].images[0].filename}`},{size:1,webkitRelativePath:`unrelated/${games[1].images[0].filename}`},{size:0,webkitRelativePath:`dataset/thumbs/${games[1].images[0].filename}`}],state.images,(checked,total)=>progress.push([checked,total]));
assert.deepEqual([...local.keys()],[2]);
assert.deepEqual(progress,[[3,3]]);
available.delete(2);
assert.equal(query('').items[0].image_id,1);
console.log('Browser catalogue, local-file progress, inclusive visit ranges, grouping, exact similarity, scene/color scoring, and float16 decoding passed.');
