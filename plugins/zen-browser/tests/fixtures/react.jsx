import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
function Form() {
  const [text, setText] = useState(''), [agreed, setAgreed] = useState(false), [city, setCity] = useState('sh'), [result, setResult] = useState('等待 React 提交');
  return <main><h1>React 受控表单</h1><form onSubmit={event => { event.preventDefault(); setResult(`React 已收到 ${text} / ${agreed} / ${city}`); }}>
    <label>React 姓名<input id="react-name" aria-label="React 姓名" value={text} onChange={event => setText(event.target.value)} /></label>
    <label>React 同意<input id="react-agree" type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)} /></label>
    <select id="react-city" aria-label="React 城市" value={city} onChange={event => setCity(event.target.value)}><option value="sh">上海</option><option value="hz">杭州</option></select>
    <button id="react-submit">提交 React</button>
  </form><p role="status">{result}</p><p id="react-state">当前状态 {text} / {String(agreed)} / {city}</p></main>;
}
createRoot(document.getElementById('root')).render(<Form />);
