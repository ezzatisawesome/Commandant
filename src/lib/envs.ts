export default {
    CESIUM_KEY: import.meta.env.PUBLIC_CESIUM_KEY,
    PROPAGATE_ENDPOINT: import.meta.env.PROD 
        ? 'https://r4bxsxsmoho7wkmd2x6km2s27q0iuueq.lambda-url.us-west-2.on.aws/'
        : 'http://127.0.0.1:5000/propagate',
    PROD: import.meta.env.PROD,
}