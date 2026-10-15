// Shared by every game. The wave itself is styled in css/base.css.

// Plays the click wave on any button: on press for mouse and touch, on activation for keyboard.
export function enableButtonWave() {
  function wave(button) {
    button.classList.remove('is-waving');
    void button.offsetWidth; // restart the animation on rapid clicks
    button.classList.add('is-waving');
  }

  document.addEventListener('pointerdown', (e) => {
    const button = e.target.closest('button');
    if (button) wave(button);
  });
  document.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (button && e.detail === 0) wave(button);
  });
  document.addEventListener('animationend', (e) => {
    if (e.animationName === 'wave') e.target.classList.remove('is-waving');
  });
}
