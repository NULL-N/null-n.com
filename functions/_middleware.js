export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname.endsWith('.pages.dev')) {
    return Response.redirect('https://null-n.com' + url.pathname + url.search, 301);
  }
  return context.next();
}
