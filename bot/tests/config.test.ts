import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

const env = {
  QUERY_HOST: 'teamspeak',
  QUERY_PORT: '10011',
  QUERY_USER: 'fake-query-user',
  QUERY_PASSWORD: 'fake-query-password',
  LARRY_URL: 'https://larry.example.test',
  LARRY_SECRET: 'fake-secret',
};

describe('readConfig', () => {
  it('reads every setting', () => {
    expect(readConfig(env)).toEqual({
      queryHost: 'teamspeak',
      queryPort: 10011,
      queryUser: 'fake-query-user',
      queryPassword: 'fake-query-password',
      larryUrl: 'https://larry.example.test',
      larrySecret: 'fake-secret',
    });
  });

  it('names every missing setting, and no value', () => {
    expect(() => readConfig({ ...env, QUERY_PASSWORD: '', LARRY_SECRET: undefined })).toThrow(
      'QUERY_PASSWORD is not set; LARRY_SECRET is not set',
    );
  });

  it('refuses a port that is not a number and a URL that is not one', () => {
    expect(() => readConfig({ ...env, QUERY_PORT: 'abc', LARRY_URL: 'larry' })).toThrow(
      'QUERY_PORT is not a port number; LARRY_URL is not a URL',
    );
  });
});
