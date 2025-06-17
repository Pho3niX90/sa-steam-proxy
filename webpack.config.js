/*
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const webpack = require('webpack');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CleanWebpackPlugin } = require('clean-webpack-plugin');

const WebPackIgnorePlugin = {
  checkResource: function (resource) {
    const lazyImports = [
      '@nestjs/microservices',
      '@nestjs/microservices/microservices-module',
      'cache-manager',
      'class-transformer',
      'class-validator',
      'fastify-static',
    ];

    if (!lazyImports.includes(resource)) return false;

    try {
      require.resolve(resource);
    } catch (err) {
      return true;
    }

    return false;
  },
};

module.exports = {
  mode: 'production',
  target: 'node',
  entry: {
    server: './src/main.ts',
  },
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
  },
  node: {
    __dirname: false,
  },
  plugins: [
    new CleanWebpackPlugin(),
    new webpack.IgnorePlugin(WebPackIgnorePlugin),
  ],
  optimization: {
    minimize: false,
  },
  performance: {
    maxEntrypointSize: 1000000000,
    maxAssetSize: 1000000000,
  },
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'prod'),
  },
};
*/
