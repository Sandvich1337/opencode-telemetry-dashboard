export const VIEW_LIFECYCLE = Object.freeze(["mount", "update", "destroy"]);

export function createViewLifecycle({ mount, update, destroy = () => {} }) {
  if (typeof mount !== "function" || typeof update !== "function" || typeof destroy !== "function") {
    throw new TypeError("A view must implement mount, update, and destroy");
  }
  return Object.freeze({ mount, update, destroy });
}

export function createViewRegistry(root = document) {
  const mounted = new Map();

  const findMountPoint = (mountPoint) => {
    if (typeof mountPoint !== "string") return mountPoint;
    const element = root.getElementById(mountPoint) || root.querySelector(`[data-view-mount="${mountPoint}"]`);
    if (!element) throw new Error(`View mount point not found: ${mountPoint}`);
    return element;
  };

  const mount = (name, view, mountPoint, props) => {
    if (mounted.has(name)) destroy(name);
    const element = findMountPoint(mountPoint);
    const mountedView = createViewLifecycle(view);
    element.hidden = false;
    mountedView.mount(element, props);
    mounted.set(name, { element, view: mountedView });
    return mountedView;
  };

  const update = (name, payload) => {
    const entry = mounted.get(name);
    if (!entry) return false;
    entry.view.update(entry.element, payload);
    return true;
  };

  function destroy(name) {
    const entry = mounted.get(name);
    if (!entry) return false;
    entry.view.destroy(entry.element);
    entry.element.replaceChildren();
    entry.element.hidden = true;
    mounted.delete(name);
    return true;
  }

  return Object.freeze({ mount, update, destroy });
}
