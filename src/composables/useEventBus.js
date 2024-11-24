import { inject, onMounted, onUnmounted } from 'vue';

async function handleEventFromPort1(event) {
  const { type, payload } = event.data;
  console.log(type, payload);

  if (type === 'load') {
    window.$bus.emitter.emit(type, payload);
  }
  if (type === 'unload') {
    window.$bus.emitter.emit(type);
  }
  if (type === 'unselect') {
    window.$bus.emitter.emit(type);
  }
}

function getMessageChannelPort2() {
  return new Promise((resolve, reject) => {
    if (window._port2) {
      resolve(window._port2);
      return;
    }
    if (window.$electron) {
      window.addEventListener('message', e => {
        if (e.source === window && e.data === 'project-volview-port') {
          const [port2] = e.ports;
          port2.onmessage = event => {
            if (event.data?.type) {
              handleEventFromPort1(event);
            } else {
              console.log('[port1]:', event.data);
            }
          };
          port2.postMessage('PONG');
          window._port2 = port2;
          resolve(window._port2);
        }
      });
      window.$electron.requestProjectVolviewPorts();
    } else {
      reject(new Error('No electron'));
    }
  });
}

async function getMessageChannelPort(retry = 100) {
  if (window.$electron) {
    return getMessageChannelPort2();
  }
  if (retry > 0) {
    await new Promise(resolve => {
      setTimeout(resolve, 100);
    });
    return getMessageChannelPort(retry - 1);
  }
  return null;
}

export function useEventBus(handlers) {
  const emitter = inject('bus');
  const bus = { emitter };

  const onload = handlers?.onload;
  const onunload = handlers?.onunload;
  const onunselect = handlers?.onunselect;
  let onslicing;
  let onclose;

  onMounted(() => {
    if (!handlers) {
      return;
    }

    window.$bus = bus;

    if (onload) {
      emitter.on('load', onload);
    }
    if (onunload) {
      emitter.on('unload', onunload);
    }
    if (onunselect) {
      emitter.on('unselect', onunselect);
    }
    getMessageChannelPort().then(port => {
      if (!port) {
        return;
      }
      onslicing = payload => {
        const port2 = port || window._port2;
        if (port2) {
          port2.postMessage({ type: 'slicing', payload });
        }
      };
      onclose = () => {
        const port2 = port || window._port2;
        if (port2) {
          port2.postMessage({ type: 'close' });
        }
      };
      emitter.on('slicing', onslicing);
      emitter.on('close', onclose);
    });
  });

  onUnmounted(() => {
    if (!handlers) {
      return;
    }

    delete window.$bus;

    if (onload) {
      emitter.off('load', onload);
    }
    if (onunload) {
      emitter.off('unload', onunload);
    }
    if (onunselect) {
      emitter.off('unselect', onunselect);
    }
    if (onslicing) {
      emitter.off('slicing', onslicing);
    }
    if (onclose) {
      emitter.off('close', onclose);
    }
  });

  return bus;
}
