import {test,expect} from '@playwright/test';

test('slow model discovery never blocks configuration status, saving, or cached navigation',async({page})=>{
  let settingsReads=0,modelReads=0,releaseSettings,releaseModels;
  const settingsGate=new Promise(resolve=>{releaseSettings=resolve;});
  const modelsGate=new Promise(resolve=>{releaseModels=resolve;});
  const state={configured:{DEEPSEEK_API_KEY:true,ALPHA_VANTAGE_API_KEY:true},model:'',schwabConnected:false,liveTrading:false};
  await page.route('**/api/settings',async route=>{
    if(route.request().method()==='GET'){settingsReads++;await settingsGate;}
    else {const {values}=route.request().postDataJSON();if(values.DEEPSEEK_MODEL)state.model=values.DEEPSEEK_MODEL;}
    await route.fulfill({json:state});
  });
  await page.route('**/api/deepseek/models',async route=>{modelReads++;await modelsGate;await route.fulfill({json:{models:[{id:'dynamic-model',name:'Available Model'}]}});});
  await page.goto('/');await page.getByRole('link',{name:'使用 ChatGPT 登录'}).click();
  await page.locator('[data-tab="integrations"]').click();
  await expect(page.locator('[name="ALPHA_VANTAGE_API_KEY"]')).toHaveAttribute('placeholder','读取配置中…');
  releaseSettings();
  await expect(page.locator('[name="ALPHA_VANTAGE_API_KEY"]')).toHaveAttribute('placeholder','已配置 · 留空保留');
  await expect(page.locator('#connection-message')).toContainText('实盘提交关闭');
  await expect.poll(()=>modelReads).toBe(1);
  await page.locator('[name="ALPHA_VANTAGE_API_KEY"]').fill('test-only');
  await page.getByRole('button',{name:'保存配置',exact:true}).click();
  await expect(page.locator('#connection-message')).toContainText('配置已加密保存');
  await page.locator('[data-tab="logs"]').click();await page.locator('[data-tab="integrations"]').click();
  await expect(page.locator('[name="ALPHA_VANTAGE_API_KEY"]')).toHaveAttribute('placeholder','已配置 · 留空保留');
  expect(settingsReads).toBe(1);expect(modelReads).toBe(1);
  releaseModels();
  await expect(page.locator('[name="DEEPSEEK_MODEL"]')).toBeEnabled();
  await expect(page.locator('[name="DEEPSEEK_MODEL"]')).toHaveValue('');
  await page.locator('[name="DEEPSEEK_MODEL"]').selectOption('dynamic-model');
  await page.getByRole('button',{name:'保存配置',exact:true}).click();
  await expect(page.locator('#connection-message')).toContainText('配置已加密保存');
  await expect(page.locator('[name="DEEPSEEK_MODEL"]')).toHaveValue('dynamic-model');
  expect(settingsReads).toBe(1);expect(modelReads).toBe(1);
});
