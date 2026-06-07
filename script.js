
const words=[
{w:'abandon',a:'放棄',o:['借用','到達','完成']},
{w:'borrow',a:'借用',o:['完成','放棄','達成']},
{w:'achieve',a:'達成',o:['放棄','借用','到達']},
{w:'discover',a:'發現',o:['放棄','借用','到達']}
];

let hpA=5,hpB=5,current;

function loadQ(){
current=words[Math.floor(Math.random()*words.length)];
document.getElementById('word').innerText=current.w;

let c=[current.a,...current.o].sort(()=>Math.random()-0.5);
document.getElementById('choices').innerHTML=
c.map(x=>`<button onclick="check('${x}')">${x}</button>`).join('');
}

function check(v){
if(v===current.a){
if(Math.random()>0.5){hpA--;}
else{hpB--;}
update();
}else{
document.getElementById('msg').innerText='❌ 答錯';
}
loadQ();
}

function update(){
document.getElementById('hpA').innerText='❤️'.repeat(hpA);
document.getElementById('hpB').innerText='❤️'.repeat(hpB);

if(hpA<=0){alert('Amber 獲勝');location.reload();}
if(hpB<=0){alert('Hanson 獲勝');location.reload();}

document.getElementById('msg').innerText='⚔️ 命中對手';
}

loadQ();
