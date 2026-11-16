// Preview copy and imagery only. No changes to the measurement or audio state.
const title = document.querySelector('[data-ro="trackTitle"]');
function updateStory(){
 const air = title.textContent.includes('NO');
 const figure = document.querySelector('.source-preview');
 figure.querySelector('img').src = air ? './data/frames/no2_hires.jpg' : './data/frames/sst_ecco2.jpg';
 figure.querySelector('img').alt = air ? 'NASA nitrogen dioxide frame over the northeastern United States' : 'NASA ECCO2 ocean current and temperature frame';
 figure.querySelector('figcaption').textContent = air ? '02 / Nitrogen dioxide · NASA SVS · published source frame' : '01 / Perpetual Ocean · NASA / ECCO2 · published source frame';
 document.querySelector('.startsay .lede').textContent = air ? 'The air around us has a story. Listen a little closer.' : 'Our planet has a story. Hear it in the ocean.';
 document.querySelector('.startsay .body').textContent = air ? 'Explore the traces of nitrogen dioxide above our cities. Hear where NASA’s picture contains a measurement, and where it falls silent.' : 'Follow the warmth of the ocean, from polar waters to the tropics. Listen to the balance of sound change as you explore NASA’s picture of our planet.';
 document.querySelector('.intro>p:last-child').textContent = air ? 'Press play. Explore nitrogen dioxide above our cities, one step at a time.' : 'Choose a place. Press play. Hear how the ocean changes from the poles to the tropics.';
 document.getElementById('trendTitle').lastChild.textContent = air ? ' Your journey through the picture' : ' Your journey across the ocean';
}
new MutationObserver(updateStory).observe(title,{childList:true,subtree:true});
updateStory();
