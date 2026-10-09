"""Real Chromium + source Vite; fixture HTTP data, no production writes or model calls."""
import json, os, pathlib, socket, subprocess, sys, tempfile, time, urllib.request
import psutil
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / '.工作台/five-graphs-20261008'
OUT.mkdir(parents=True, exist_ok=True)
HTML = OUT / 'business-harness.html'
HTML.write_text('''<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="root" style="height:100vh;display:flex;flex-direction:column"></div><script type="module">
import React from '/node_modules/.vite/deps/react.js';
import {createRoot} from '/node_modules/.vite/deps/react-dom_client.js';
import {BusinessDataFlowView} from '/src/ui/arch/BusinessDataFlowView.tsx';
import '/src/ui/index.css';
const root=createRoot(document.getElementById('root'));
window.renderProject=id=>root.render(React.createElement(BusinessDataFlowView,{projectId:id,key:id}));
window.renderProject('tatai');
</script></body></html>''', encoding='utf-8')
# Vite resolves bare imports in HTML module scripts, keeping the cache local.
HTML.write_text(HTML.read_text(encoding='utf-8').replace("'/node_modules/.vite/deps/react.js'", "'react'").replace("'/node_modules/.vite/deps/react-dom_client.js'", "'react-dom/client'"), encoding='utf-8')
model_path = pathlib.Path(os.environ.get('TATAI_BUSINESS_MODEL', str(OUT/'current-business-model.json')))
if model_path.exists():
    model=json.loads(model_path.read_text(encoding='utf-8'))
else:
    snapshot=json.loads((OUT/'before-graphs.json').read_text(encoding='utf-8'))
    model=snapshot['graphs']['data_flow']['tech']
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
env=dict(os.environ, TATAI_DEV_API_PORT='1', TATAI_VITE_CACHE_DIR=str(OUT/'vite-browser-cache'))
log=(OUT/'business-vite.log').open('w',encoding='utf-8')
proc=subprocess.Popen(['node',str(ROOT/'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',str(port),'--strictPort'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
url=f'http://127.0.0.1:{port}/.工作台/five-graphs-20261008/business-harness.html'
state={'fail':False,'requests':0}
try:
    for _ in range(120):
        if proc.poll() is not None: raise RuntimeError('Vite exited')
        try:
            opener.open(f'http://127.0.0.1:{port}/',timeout=1); break
        except Exception: time.sleep(.25)
    with sync_playwright() as p:
        try: browser=p.chromium.launch(headless=True)
        except Exception: browser=p.chromium.launch(channel='msedge',headless=True)
        page=browser.new_page(viewport={'width':1500,'height':950})
        errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        def serve(route):
            state['requests']+=1
            if state['fail']: route.fulfill(status=503,content_type='application/json',body=json.dumps({'ok':False,'error':{'code':'FIXTURE_UNAVAILABLE','message':'fixture unavailable'}}))
            else:
                current=json.loads(json.dumps(model))
                if '/other/' in route.request.url:
                    current['project_id']='other'; current['nodes']=[];current['edges']=[];current['chains']=[]
                    current['coverage']={'declared_total':0,'covered':0,'missing':0,'not_implemented':0,'rows':[],'missing_paths':[],'note':'第二项目尚无声明'}
                route.fulfill(content_type='application/json',body=json.dumps({'ok':True,'data_flow':current},ensure_ascii=False))
        page.route('**/api/projects/*/arch/dataflow',serve)
        page.goto(url)
        expect(page.locator('[data-business-flow]')).to_be_visible(timeout=30000)
        expect(page.locator('.react-flow__node')).to_have_count(len(model['nodes']),timeout=30000)
        expect(page.locator('.react-flow__edge')).to_have_count(len(model['edges']))
        first=model['nodes'][0]
        page.locator(f'.react-flow__node[data-id="{first["id"]}"]').click()
        detail=page.locator('[data-business-flow-detail]')
        expect(detail).to_have_attribute('data-business-flow-detail',first['id'])
        expect(detail.locator('[data-business-flow-verification]')).to_have_attribute('data-business-flow-verification',first['verification'])
        expect(detail.locator('[data-flow-evidence]')).to_have_count(len(first['evidence']))
        page.get_by_role('button',name='关闭数据路径详情').click()
        edge=model['edges'][0]
        page.locator(f'.react-flow__edge[data-id="{edge["id"]}"]').click(force=True)
        expect(detail).to_have_attribute('data-business-flow-detail',edge['id'])
        expect(detail.locator('[data-business-flow-verification]')).to_have_attribute('data-business-flow-verification',edge['verification'])
        page.get_by_role('button',name='关闭数据路径详情').click()
        chain=model['chains'][0]
        page.get_by_label('选择数据路径').select_option(chain['id'])
        expect(page.locator('.react-flow__node')).to_have_count(len(set(h['node_id'] for h in chain['hops'])))
        page.get_by_label('选择数据路径').select_option('')
        expect(page.locator('.react-flow__node')).to_have_count(len(model['nodes']))
        state['fail']=True
        page.evaluate("window.dispatchEvent(new Event('online'))")
        expect(page.locator('[data-business-flow]')).to_have_attribute('data-business-flow-stale','1',timeout=20000)
        expect(page.locator('.react-flow__node')).to_have_count(len(model['nodes']))
        expect(page.get_by_role('alert')).to_contain_text('陈旧')
        state['fail']=False
        page.evaluate("window.dispatchEvent(new Event('online'))")
        expect(page.locator('[data-business-flow]')).to_have_attribute('data-business-flow-stale','0',timeout=20000)
        page.screenshot(path=str(OUT/'business-canvas.png'))
        page.evaluate("window.renderProject('other')")
        expect(page.locator('[data-business-flow-project="other"]')).to_be_visible()
        expect(page.locator('.react-flow__node')).to_have_count(0)
        expect(page.get_by_text('尚无可绘制的业务数据路径。第二项目尚无声明')).to_be_visible()
        assert not errors,errors
        print(json.dumps({'result':'PASS','requests':state['requests'],'page_errors':errors,'method':'real Chromium/source Vite; controlled HTTP fixture from actual six-graph snapshot'},ensure_ascii=False))
        browser.close()
finally:
    try:
        parent=psutil.Process(proc.pid)
        children=parent.children(recursive=True)
        for child in children: child.terminate()
        parent.terminate()
        gone,alive=psutil.wait_procs(children+[parent],timeout=5)
        for child in alive: child.kill()
        psutil.wait_procs(alive,timeout=5)
    except psutil.NoSuchProcess: pass
    log.close()
