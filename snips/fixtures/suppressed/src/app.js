// the addon is resolved by our build step, not by the package manager
import addon from 'optional-native-addon';
import missing from 'genuinely-missing';

export const app = { addon, missing };
