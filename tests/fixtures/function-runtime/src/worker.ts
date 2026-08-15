export default {
  fetch() {
    return new Response("custom worker", { status: 404 });
  },
};
